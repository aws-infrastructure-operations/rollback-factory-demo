import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { SNSEvent } from 'aws-lambda';
import { ConfigOverrides, getConfig } from '../lib/config.js';
import { ApiUserStack } from '../lib/api-user-stack.js';
import type { DeploymentRecord } from '../lambda/shared/deployments.js';
import {
  AlarmPair, isRestoreRequest, lambdaArnsFromSpec, lambdaFault, ownAlarms, parseAlarms, planRollback, pointToAlias,
} from '../lambda/rollback/plan.js';

const synth = (env: string, overrides: ConfigOverrides = {}) => {
  const app = new cdk.App();
  return Template.fromStack(new ApiUserStack(app, `Test-${env}`, { config: getConfig(env, overrides) }));
};

describe('stack', () => {
  const t = synth('dev');

  test('creates a 4xx and a 5xx rate alarm wired to the SNS topic', () => {
    for (const [kind, threshold, min] of [['4xx', 25, 20], ['5xx', 5, 5]] as const) {
      t.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `rollback-factory-demo-api-user-${kind}-rate-dev`,
        Threshold: threshold,
        ActionsEnabled: true,
        AlarmActions: [{ Ref: Match.stringLikeRegexp('AlarmTopic') }],
        Metrics: Match.arrayWith([
          Match.objectLike({ Expression: `IF(requests >= ${min}, 100 * errors / requests, 0)` }),
        ]),
      });
    }
  });

  test('lets CloudWatch publish the API alarms to the SSL-only topic', () => {
    const policies = Object.values(t.findResources('AWS::SNS::TopicPolicy')) as any[];
    assert.equal(policies.length, 1);
    const statements = policies[0].Properties.PolicyDocument.Statement as any[];
    const allow = statements.find((s) => s.Sid === 'AllowCloudWatchAlarms');
    assert.ok(allow, 'missing AllowCloudWatchAlarms statement');
    assert.equal(allow.Effect, 'Allow');
    assert.deepEqual(allow.Principal, { Service: 'cloudwatch.amazonaws.com' });
    assert.equal(allow.Action, 'sns:Publish');
    assert.deepEqual(allow.Condition.StringEquals, { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } });
    const alarmIds = Object.keys(t.findResources('AWS::CloudWatch::Alarm')).sort();
    const sourceArns = (allow.Condition.ArnLike['aws:SourceArn'] as any[]).map((a) => a['Fn::GetAtt'][0]).sort();
    assert.deepEqual(sourceArns, alarmIds);
    // the SSL-only deny is still there
    assert.ok(statements.some((s) => s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false'));
  });

  test('alarm notifications can be switched off', () => {
    synth('dev', { alarmNotifications: 'false' })
      .allResourcesProperties('AWS::CloudWatch::Alarm', { ActionsEnabled: false });
  });

  test('subscribes the rollback Lambda (and optional e-mail) to the topic', () => {
    for (const env of ['dev', 'prod']) {
      synth(env).hasResourceProperties('AWS::SNS::Topic', { TopicName: `rollback-factory-demo-notifications-${env}` });
    }
    t.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'lambda',
      FilterPolicyScope: 'MessageBody',
      FilterPolicy: { AlarmName: ['rollback-factory-demo-api-user-4xx-rate-dev', 'rollback-factory-demo-api-user-5xx-rate-dev'] },
    });
    t.resourcePropertiesCountIs('AWS::SNS::Subscription', { Protocol: 'email' }, 0);
    synth('dev', { alarmEmail: 'ops@example.com' })
      .hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
  });

  test('configures the rollback Lambda', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'rollback-factory-demo-rollback-dev',
      Environment: {
        Variables: Match.objectLike({
          STAGE_NAME: 'v1',
          ROLLBACK_WINDOW_MINUTES: '30',
          ALARM_NAMES: 'rollback-factory-demo-api-user-4xx-rate-dev,rollback-factory-demo-api-user-5xx-rate-dev',
        }),
      },
    });
    synth('dev', { rollbackWindowMinutes: '10' }).hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'rollback-factory-demo-rollback-dev',
      Environment: { Variables: Match.objectLike({ ROLLBACK_WINDOW_MINUTES: '10' }) },
    });
  });

  const aliases = (template: Template): Record<string, any> => Object.fromEntries(
    Object.entries(template.findResources('AWS::Lambda::Alias')).map(([id, r]: [string, any]) => [r.Properties.Name, { id, ...r.Properties }]),
  );
  const stage = (template: Template, name: string) =>
    (Object.values(template.findResources('AWS::ApiGateway::Stage')) as any[]).find((r) => r.Properties.StageName === name)!.Properties;

  test('each stage invokes its own alias of the handler (stage variable lambdaAlias)', () => {
    const uris = Object.values(t.findResources('AWS::ApiGateway::Method'))
      .filter((m: any) => m.Properties.HttpMethod !== 'OPTIONS') // CORS preflights are mock integrations
      .map((m: any) => JSON.stringify(m.Properties.Integration.Uri));
    assert.equal(uris.length, 4);
    for (const uri of uris) assert.ok(uri.includes(':${stageVariables.lambdaAlias}/invocations'), uri);

    assert.deepEqual(Object.keys(aliases(t)).sort(), ['integration', 'live']);
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
    const { integration, live } = aliases(t);
    assert.deepEqual(live.FunctionVersion, integration.FunctionVersion);
    assert.deepEqual(stage(t, 'v1').DeploymentId, stage(t, 'integration').DeploymentId);
  });

  test('with live context (CI), a deploy leaves v1 and the live alias where they are', () => {
    const pinned = synth('dev', { liveDeploymentId: 'dep123', liveLambdaVersion: '7' });
    assert.equal(stage(pinned, 'v1').DeploymentId, 'dep123');
    assert.equal(aliases(pinned).live.FunctionVersion, '7');
    // the integration stage and alias still get the new deployment and version
    assert.ok(JSON.stringify(stage(pinned, 'integration').DeploymentId).includes('ApiDeployment'));
    assert.ok(JSON.stringify(aliases(pinned).integration.FunctionVersion).includes('ApiHandlerCurrentVersion'));
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
        AlarmName: `rollback-factory-demo-lambda-${kind}-rate-dev`,
        Threshold: threshold,
        AlarmActions: [{ Ref: Match.stringLikeRegexp('AlarmTopic') }],
        Metrics: Match.arrayWith([
          Match.objectLike({ Expression: `IF(requests >= ${min}, 100 * errors / requests, 0)` }),
        ]),
      });
    }
    const [fn] = Object.values(t.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'rollback-factory-demo-rollback-dev' },
    })) as any[];
    const vars = fn.Properties.Environment.Variables;
    assert.deepEqual(JSON.parse(vars.ALARM_PAIRS), [
      {
        apiAlarm: 'rollback-factory-demo-api-user-4xx-rate-dev',
        lambdaAlarm: 'rollback-factory-demo-lambda-4xx-rate-dev',
        apiMetric: '4XXError',
        lambdaMetric: 'Lambda4XXError',
      },
      {
        apiAlarm: 'rollback-factory-demo-api-user-5xx-rate-dev',
        lambdaAlarm: 'rollback-factory-demo-lambda-5xx-rate-dev',
        apiMetric: '5XXError',
        lambdaMetric: 'Lambda5XXError',
      },
    ]);
    assert.ok(vars.HANDLER_FUNCTION_ARN, 'rollback Lambda needs the handler to point restored specs at its stage alias');
  });

  test('chaosFailureRate reaches the API handler', () => {
    synth('dev', { chaosFailureRate: '1' }).hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'rollback-factory-demo-handler-dev',
      Environment: { Variables: Match.objectLike({ CHAOS_FAILURE_RATE: '1' }) },
    });
    assert.throws(() => getConfig('dev', { chaosFailureRate: '2' }), /between 0 and 1/);
  });
});

describe('planRollback', () => {
  const now = new Date('2026-10-06T12:30:00.000Z');
  const rec = (deployedAt: string, deploymentId: string, extra: Partial<DeploymentRecord> = {}) =>
    ({ apiName: 'api-user-dev', deployedAt, deploymentId, source: 'cicd', ...extra }) as DeploymentRecord;

  const good = rec('2026-10-06T11:00:00.000Z', 'good', { verifiedAt: '2026-10-06T11:02:00.000Z' });
  const bad = rec('2026-10-06T12:20:00.000Z', 'bad');

  test('rolls the recent deployment back to the previous verified one', () => {
    assert.deepEqual(planRollback([bad, good], now, 30), { action: 'rollback', from: bad, to: good });
  });

  test('skips deployments older than the window', () => {
    const plan = planRollback([bad, good], now, 5);
    assert.equal(plan.action, 'skip');
    assert.match((plan as any).reason, /10 min old \(window: 5 min\)/);
  });

  test('never rolls back a rollback or an already rolled back deployment', () => {
    const rollback = rec('2026-10-06T12:25:00.000Z', 'r1', { source: 'rollback' });
    assert.equal(planRollback([rollback, bad, good], now, 30).action, 'skip');
    const restore = rec('2026-10-06T12:25:00.000Z', 'r2', { source: 'restore' });
    assert.equal(planRollback([restore, bad, good], now, 30).action, 'skip');
    assert.equal(planRollback([{ ...bad, rolledBackAt: now.toISOString() }, good], now, 30).action, 'skip');
  });

  test('skips the same deployment id recorded twice and needs a target', () => {
    const dupe = rec('2026-10-06T12:10:00.000Z', 'bad');
    assert.deepEqual(planRollback([bad, dupe, good], now, 30), { action: 'rollback', from: bad, to: good });
    assert.equal(planRollback([bad], now, 30).action, 'skip');
    assert.equal(planRollback([], now, 30).action, 'skip');
  });

  // What broke dev on 2026-10-06: a broken demo deploy was never rolled back (the alarm
  // couldn't publish), so the next failed deploy was "rolled back" onto it.
  test('never restores an unverified deployment, even if it is the previous one', () => {
    const untestedBroken = rec('2026-10-06T12:00:00.000Z', 'broken');
    const plan = planRollback([bad, untestedBroken, good], now, 30);
    assert.deepEqual(plan, { action: 'rollback', from: bad, to: good });
    assert.deepEqual(planRollback([bad, untestedBroken], now, 30), {
      action: 'skip', reason: 'no earlier verified deployment to roll back to',
    });
  });

  test('never restores a verified deployment that was rolled back later', () => {
    const verifiedButRolledBack = rec('2026-10-06T12:00:00.000Z', 'flaky', {
      verifiedAt: '2026-10-06T12:01:00.000Z', rolledBackAt: '2026-10-06T12:10:00.000Z',
    });
    assert.deepEqual(planRollback([bad, verifiedButRolledBack, good], now, 30), { action: 'rollback', from: bad, to: good });
  });
});

test('recognises manual restore requests', () => {
  assert.ok(isRestoreRequest({ restore: { deployedAt: '2026-10-06T11:38:01.784Z' } }));
  assert.ok(!isRestoreRequest({ Records: [] }));
  assert.ok(!isRestoreRequest({ restore: {} }));
});

test('parses CloudWatch alarm notifications from SNS', () => {
  const event = {
    Records: [{ Sns: { Message: JSON.stringify({
      AlarmName: 'rollback-factory-demo-api-user-5xx-rate-dev', NewStateValue: 'ALARM', NewStateReason: 'Threshold Crossed',
    }) } }],
  } as unknown as SNSEvent;
  assert.deepEqual(parseAlarms(event), [
    { alarmName: 'rollback-factory-demo-api-user-5xx-rate-dev', newState: 'ALARM', reason: 'Threshold Crossed' },
  ]);
});

test('finds the versioned Lambda ARNs in an exported spec', () => {
  const fn = 'arn:aws:lambda:eu-west-1:123456789012:function:rollback-factory-demo-handler-dev:7';
  const integration = {
    type: 'aws_proxy',
    uri: `arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/${fn}/invocations`,
  };
  const spec = {
    paths: {
      '/users': { get: { 'x-amazon-apigateway-integration': integration }, post: { 'x-amazon-apigateway-integration': integration } },
      '/health': { get: { 'x-amazon-apigateway-integration': { type: 'mock' } } },
    },
  };
  assert.deepEqual(lambdaArnsFromSpec(spec), [fn]);
});

test('only acts on ALARM transitions of its own API', () => {
  const alarms = [
    { alarmName: 'rollback-factory-demo-api-user-5xx-rate-dev', newState: 'ALARM', reason: '' },
    { alarmName: 'rollback-factory-demo-api-user-5xx-rate-prod', newState: 'ALARM', reason: '' },
    { alarmName: 'rollback-factory-demo-api-user-4xx-rate-dev', newState: 'OK', reason: '' },
  ];
  const dev = Object.values(getConfig('dev').alarmNames);
  const prod = Object.values(getConfig('prod').alarmNames);
  assert.deepEqual(ownAlarms(alarms, dev).map((a) => a.alarmName), ['rollback-factory-demo-api-user-5xx-rate-dev']);
  assert.deepEqual(ownAlarms(alarms, prod).map((a) => a.alarmName), ['rollback-factory-demo-api-user-5xx-rate-prod']);
});

describe('lambdaFault', () => {
  const pair: AlarmPair = {
    apiAlarm: 'rollback-factory-demo-api-user-5xx-rate-dev',
    lambdaAlarm: 'rollback-factory-demo-lambda-5xx-rate-dev',
    apiMetric: '5XXError',
    lambdaMetric: 'Lambda5XXError',
  };

  test('blames the Lambda while its paired alarm is in ALARM', () => {
    assert.match(lambdaFault(pair, { lambdaAlarmState: 'ALARM', apiErrors: 10, lambdaErrors: 0 })!, /lambda-5xx-rate-dev is in ALARM/);
  });

  test('blames the Lambda when it produced at least half of the errors, even before its alarm fires', () => {
    assert.match(lambdaFault(pair, { lambdaAlarmState: 'OK', apiErrors: 10, lambdaErrors: 5 })!, /5 of the 10 5XXError/);
  });

  test('lets the API roll back when API Gateway produced most errors', () => {
    assert.equal(lambdaFault(pair, { lambdaAlarmState: 'OK', apiErrors: 10, lambdaErrors: 4 }), undefined);
    assert.equal(lambdaFault(pair, { lambdaAlarmState: 'INSUFFICIENT_DATA', apiErrors: 0, lambdaErrors: 0 }), undefined);
  });
});

test('points restored specs at the live alias, whatever version they were recorded with', () => {
  const fn = 'arn:aws:lambda:eu-west-1:123456789012:function:rollback-factory-demo-handler-dev';
  const other = 'arn:aws:lambda:eu-west-1:123456789012:function:rollback-factory-demo-handler-dev-other:3';
  const uri = (arn: string) => `arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/${arn}/invocations`;
  const op = (arn: string) => ({ 'x-amazon-apigateway-integration': { type: 'aws_proxy', uri: uri(arn) } });
  const spec = {
    paths: {
      '/users': { get: op(`${fn}:7`), post: op(`${fn}:live`) },
      '/messages': { get: op(fn), post: op(other) },
      '/health': { get: { 'x-amazon-apigateway-integration': { type: 'mock' } } },
    },
  };
  const result = pointToAlias(spec, fn, `${fn}:live`);
  assert.deepEqual(lambdaArnsFromSpec(result).sort(), [`${fn}:live`, other].sort());
  assert.equal(result.paths['/users'].get['x-amazon-apigateway-integration'].uri, uri(`${fn}:live`));
  // the input is not modified
  assert.equal(spec.paths['/users'].get['x-amazon-apigateway-integration'].uri, uri(`${fn}:7`));
});
