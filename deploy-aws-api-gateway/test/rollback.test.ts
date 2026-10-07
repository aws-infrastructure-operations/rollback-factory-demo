import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ConfigOverrides, getConfig } from '../lib/config.js';
import { ApiUserStack } from '../lib/api-user-stack.js';

// The rollback itself is done by the rollback service (rollback-service/): its API Gateway
// manager's tests live there. This stack only names the alarms, points them at the service's
// topic and publishes the RollbackTarget the manager reads.

const synth = (env: string, overrides: ConfigOverrides = {}) => {
  const app = new cdk.App();
  return Template.fromStack(new ApiUserStack(app, `Test-${env}`, { config: getConfig(env, overrides) }));
};

/** Alarm actions point at the rollback service's topic, rollback-factory-demo-rollback-notifications-<env>. */
const publishesToRollbackService = (alarm: any, env = 'dev') =>
  JSON.stringify(alarm.Properties.AlarmActions).includes(`:rollback-factory-demo-rollback-notifications-${env}`);

const alarmsByName = (t: Template) => Object.fromEntries(Object.values(t.findResources('AWS::CloudWatch::Alarm'))
  .map((a: any) => [a.Properties.AlarmName, a]));

describe('stack', () => {
  const t = synth('dev');

  test('names the rollback alarms rollback-factory-demo-apigateway-api-user-<metric>-<env>', () => {
    for (const [kind, threshold, min] of [['4xx', 25, 20], ['5xx', 5, 5]] as const) {
      t.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `rollback-factory-demo-apigateway-api-user-${kind}-rate-dev`,
        Threshold: threshold,
        ActionsEnabled: true,
        Metrics: Match.arrayWith([
          Match.objectLike({ Expression: `IF(requests >= ${min}, 100 * errors / requests, 0)` }),
        ]),
      });
    }
  });

  test('every alarm publishes to the rollback service topic; the stack has no topic or rollback Lambda of its own', () => {
    const alarms = alarmsByName(t);
    assert.deepEqual(Object.keys(alarms).sort(), [
      'rollback-factory-demo-apigateway-api-user-4xx-rate-dev',
      'rollback-factory-demo-apigateway-api-user-5xx-rate-dev',
      'rollback-factory-demo-apigateway-api-user-handler-4xx-rate-dev',
      'rollback-factory-demo-apigateway-api-user-handler-5xx-rate-dev',
      'rollback-factory-demo-lambda-api-messages-errors-dev',
      'rollback-factory-demo-lambda-api-users-errors-dev',
    ]);
    for (const [name, alarm] of Object.entries(alarms)) assert.ok(publishesToRollbackService(alarm), name);
    t.resourceCountIs('AWS::SNS::Topic', 0);
    t.resourceCountIs('AWS::SNS::Subscription', 0);
    const functions = Object.values(t.findResources('AWS::Lambda::Function')).map((f: any) => f.Properties.FunctionName);
    assert.ok(!functions.includes('rollback-factory-demo-rollback-dev'));
  });

  test('alarm notifications can be switched off', () => {
    synth('dev', { alarmNotifications: 'false' })
      .allResourcesProperties('AWS::CloudWatch::Alarm', { ActionsEnabled: false });
  });

  test('does not export RollbackTarget: export values may be 1024 characters at most', () => {
    const outputs = t.findOutputs('*');
    // the rollback service reads it with DescribeStacks; nothing imports it
    assert.equal(outputs.RollbackTarget.Export, undefined);
    // the exported outputs are single values, never a JSON document that grows with the stack
    for (const [name, output] of Object.entries(outputs)) {
      if (output.Export) assert.doesNotMatch(JSON.stringify(output.Value), /Fn::Join.*\{\\\\"/, name);
    }
  });

  test('publishes the RollbackTarget the rollback service reads', () => {
    const output = JSON.stringify(t.findOutputs('RollbackTarget').RollbackTarget.Value);
    for (const expected of [
      'rollback-factory-demo-apigateway-api-user-4xx-rate-dev',
      'rollback-factory-demo-apigateway-api-user-handler-5xx-rate-dev',
      'Lambda4XXError',
      'rollback-factory-demo/api-user-dev',
      '\\"rollbackWindowMinutes\\":30',
      '\\"stageName\\":\\"v1\\"',
      'backendFunctionArns',
    ]) assert.ok(output.includes(expected), `RollbackTarget lacks ${expected}`);
    // both backends, so an API rollback keeps both on their stage alias
    assert.match(output, /UsersHandler[0-9A-F]{8}/);
    assert.match(output, /MessagesHandler[0-9A-F]{8}/);
    assert.match(output, /ApiUserApi|Api[A-F0-9]{8}/, 'restApiId is a reference to the API');
    assert.ok(JSON.stringify(synth('dev', { rollbackWindowMinutes: '10' }).findOutputs('RollbackTarget')).includes('\\"rollbackWindowMinutes\\":10'));
  });

  /** The aliases by "<function construct>:<alias>", e.g. "UsersHandler:live". */
  const aliases = (template: Template): Record<string, any> => Object.fromEntries(
    Object.entries(template.findResources('AWS::Lambda::Alias')).map(([id, r]: [string, any]) => [
      `${r.Properties.FunctionName.Ref.replace(/[0-9A-F]{8}$/, '')}:${r.Properties.Name}`, { id, ...r.Properties },
    ]),
  );
  const stage = (template: Template, name: string) =>
    (Object.values(template.findResources('AWS::ApiGateway::Stage')) as any[]).find((r) => r.Properties.StageName === name)!.Properties;

  test('each resource has its own Lambda, and each stage invokes its alias of it (stage variable lambdaAlias)', () => {
    const functions = Object.entries(t.findResources('AWS::Lambda::Function'))
      .filter(([, f]: [string, any]) => /api-(users|messages)-dev$/.test(f.Properties.FunctionName))
      .map(([id, f]: [string, any]) => [f.Properties.FunctionName, id]);
    assert.deepEqual(functions.map(([name]) => name).sort(), ['rollback-factory-demo-api-messages-dev', 'rollback-factory-demo-api-users-dev']);

    const methods = Object.values(t.findResources('AWS::ApiGateway::Method'))
      .filter((m: any) => m.Properties.HttpMethod !== 'OPTIONS'); // CORS preflights are mock integrations
    assert.equal(methods.length, 4);
    const resources = t.findResources('AWS::ApiGateway::Resource');
    for (const m of methods as any[]) {
      const path = resources[m.Properties.ResourceId.Ref].Properties.PathPart;
      const uri = JSON.stringify(m.Properties.Integration.Uri);
      assert.ok(uri.includes(':${stageVariables.lambdaAlias}/invocations'), uri);
      const [, fnId] = functions.find(([name]) => name.endsWith(`api-${path}-dev`))!;
      assert.ok(uri.includes(`"${fnId}"`), `/${path} invokes its own function: ${uri}`);
    }

    assert.deepEqual(Object.keys(aliases(t)).sort(), [
      'MessagesHandler:integration', 'MessagesHandler:live', 'UsersHandler:integration', 'UsersHandler:live',
    ]);
    assert.deepEqual(stage(t, 'v1').Variables, { lambdaAlias: 'live' });
    assert.deepEqual(stage(t, 'integration').Variables, { lambdaAlias: 'integration' });
    for (const { id } of Object.values(aliases(t))) {
      t.hasResourceProperties('AWS::Lambda::Permission', {
        FunctionName: { Ref: id },
        Principal: 'apigateway.amazonaws.com',
      });
    }
    // v1 may serve an older deployment than the integration stage, and old specs reference versions
    t.hasResource('AWS::ApiGateway::Deployment', { DeletionPolicy: 'Retain' });
    t.hasResource('AWS::Lambda::Version', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });

  test('without live context, a deploy updates v1 and both aliases directly', () => {
    for (const fn of ['UsersHandler', 'MessagesHandler']) {
      assert.deepEqual(aliases(t)[`${fn}:live`].FunctionVersion, aliases(t)[`${fn}:integration`].FunctionVersion, fn);
    }
    assert.deepEqual(stage(t, 'v1').DeploymentId, stage(t, 'integration').DeploymentId);
  });

  test('with live context (CI), a deploy leaves v1 and the live alias where they are', () => {
    const pinned = synth('dev', { liveDeploymentId: 'dep123', liveUsersVersion: '7', liveMessagesVersion: '3' });
    assert.equal(stage(pinned, 'v1').DeploymentId, 'dep123');
    assert.equal(aliases(pinned)['UsersHandler:live'].FunctionVersion, '7');
    assert.equal(aliases(pinned)['MessagesHandler:live'].FunctionVersion, '3');
    // the integration stage and aliases still get the new deployment and versions
    assert.ok(JSON.stringify(stage(pinned, 'integration').DeploymentId).includes('ApiDeployment'));
    assert.ok(JSON.stringify(aliases(pinned)['UsersHandler:integration'].FunctionVersion).includes('UsersHandlerCurrentVersion'));
    assert.ok(JSON.stringify(aliases(pinned)['MessagesHandler:integration'].FunctionVersion).includes('MessagesHandlerCurrentVersion'));
    // one backend pinned, the other not deployed yet: that one's live goes to the new version
    const half = synth('dev', { liveUsersVersion: '7' });
    assert.ok(JSON.stringify(aliases(half)['MessagesHandler:live'].FunctionVersion).includes('MessagesHandlerCurrentVersion'));
  });

  test('pairs each API alarm with an alarm on the errors the Lambda produced', () => {
    for (const [kind, threshold, min] of [['4xx', 25, 20], ['5xx', 5, 5]] as const) {
      t.hasResourceProperties('AWS::Logs::MetricFilter', {
        FilterName: `rollback-factory-demo-lambda-${kind}-dev`,
        FilterPattern: `{ ($.status = "${kind[0]}*") && ($.lambdaRequestId != "-") }`,
        MetricTransformations: [{
          MetricNamespace: 'rollback-factory-demo/api-user-dev',
          MetricName: `Lambda${kind.toUpperCase()}Error`,
          MetricValue: '1',
          DefaultValue: 0,
        }],
      });
      t.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `rollback-factory-demo-apigateway-api-user-handler-${kind}-rate-dev`,
        Threshold: threshold,
        Metrics: Match.arrayWith([
          Match.objectLike({ Expression: `IF(requests >= ${min}, 100 * errors / requests, 0)` }),
        ]),
      });
    }
  });

  test('chaosFailureRate reaches both backends', () => {
    const chaos = synth('dev', { chaosFailureRate: '1' });
    for (const backend of ['users', 'messages']) {
      chaos.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `rollback-factory-demo-api-${backend}-dev`,
        Environment: { Variables: Match.objectLike({ CHAOS_FAILURE_RATE: '1' }) },
      });
    }
    assert.throws(() => getConfig('dev', { chaosFailureRate: '2' }), /between 0 and 1/);
  });
});
