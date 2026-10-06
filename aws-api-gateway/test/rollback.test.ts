import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { SNSEvent } from 'aws-lambda';
import { ConfigOverrides, getConfig } from '../lib/config.js';
import { ApiUserStack } from '../lib/api-user-stack.js';
import type { DeploymentRecord } from '../lambda/shared/deployments.js';
import { lambdaArnsFromSpec, parseAlarms, planRollback } from '../lambda/rollback/plan.js';

const synth = (env: string, overrides: ConfigOverrides = {}) => {
  const app = new cdk.App();
  return Template.fromStack(new ApiUserStack(app, `Test-${env}`, { config: getConfig(env, overrides) }));
};

describe('stack', () => {
  const t = synth('dev');

  test('creates a 4xx and a 5xx rate alarm wired to the SNS topic', () => {
    for (const [kind, threshold, min] of [['4xx', 25, 20], ['5xx', 5, 5]] as const) {
      t.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `api-user-dev-v1-${kind}-rate`,
        Threshold: threshold,
        ActionsEnabled: true,
        AlarmActions: [{ Ref: Match.stringLikeRegexp('AlarmTopic') }],
        Metrics: Match.arrayWith([
          Match.objectLike({ Expression: `IF(requests >= ${min}, 100 * errors / requests, 0)` }),
        ]),
      });
    }
  });

  test('alarm notifications can be switched off', () => {
    synth('dev', { alarmNotifications: 'false' })
      .allResourcesProperties('AWS::CloudWatch::Alarm', { ActionsEnabled: false });
  });

  test('subscribes the rollback Lambda (and optional e-mail) to the topic', () => {
    t.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'api-user-dev-alarms' });
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'lambda' });
    t.resourcePropertiesCountIs('AWS::SNS::Subscription', { Protocol: 'email' }, 0);
    synth('dev', { alarmEmail: 'ops@example.com' })
      .hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
  });

  test('configures the rollback Lambda', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'api-user-dev-rollback',
      Environment: {
        Variables: Match.objectLike({ STAGE_NAME: 'v1', ROLLBACK_WINDOW_MINUTES: '30' }),
      },
    });
    synth('dev', { rollbackWindowMinutes: '10' }).hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'api-user-dev-rollback',
      Environment: { Variables: Match.objectLike({ ROLLBACK_WINDOW_MINUTES: '10' }) },
    });
  });

  test('integrates the API with a published Lambda version', () => {
    const versions = Object.keys(t.findResources('AWS::Lambda::Version'));
    assert.equal(versions.length, 1);
    const uris = Object.values(t.findResources('AWS::ApiGateway::Method'))
      .map((m: any) => JSON.stringify(m.Properties.Integration.Uri));
    assert.equal(uris.length, 4);
    for (const uri of uris) assert.ok(uri.includes(`"Ref":"${versions[0]}"`), uri);
    // old versions must survive replacement, rollbacks re-point the API at them
    t.hasResource('AWS::Lambda::Version', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });

  test('chaosFailureRate reaches the API handler', () => {
    synth('dev', { chaosFailureRate: '1' }).hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'api-user-dev-handler',
      Environment: { Variables: Match.objectLike({ CHAOS_FAILURE_RATE: '1' }) },
    });
    assert.throws(() => getConfig('dev', { chaosFailureRate: '2' }), /between 0 and 1/);
  });
});

describe('planRollback', () => {
  const now = new Date('2026-10-06T12:30:00.000Z');
  const rec = (deployedAt: string, deploymentId: string, extra: Partial<DeploymentRecord> = {}) =>
    ({ apiName: 'api-user-dev', deployedAt, deploymentId, source: 'cicd', ...extra }) as DeploymentRecord;

  const good = rec('2026-10-06T11:00:00.000Z', 'good');
  const bad = rec('2026-10-06T12:20:00.000Z', 'bad');

  test('rolls the recent deployment back to the previous one', () => {
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
    assert.equal(planRollback([{ ...bad, rolledBackAt: now.toISOString() }, good], now, 30).action, 'skip');
  });

  test('skips the same deployment id recorded twice and needs a target', () => {
    const dupe = rec('2026-10-06T12:10:00.000Z', 'bad');
    assert.deepEqual(planRollback([bad, dupe, good], now, 30), { action: 'rollback', from: bad, to: good });
    assert.equal(planRollback([bad], now, 30).action, 'skip');
    assert.equal(planRollback([], now, 30).action, 'skip');
  });
});

test('parses CloudWatch alarm notifications from SNS', () => {
  const event = {
    Records: [{ Sns: { Message: JSON.stringify({
      AlarmName: 'api-user-dev-v1-5xx-rate', NewStateValue: 'ALARM', NewStateReason: 'Threshold Crossed',
    }) } }],
  } as unknown as SNSEvent;
  assert.deepEqual(parseAlarms(event), [
    { alarmName: 'api-user-dev-v1-5xx-rate', newState: 'ALARM', reason: 'Threshold Crossed' },
  ]);
});

test('finds the versioned Lambda ARNs in an exported spec', () => {
  const fn = 'arn:aws:lambda:eu-west-1:123456789012:function:api-user-dev-handler:7';
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
