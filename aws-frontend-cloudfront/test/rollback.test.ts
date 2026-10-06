import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SNSEvent } from 'aws-lambda';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DeploymentRecord } from '../lambda/shared/deployments.js';
import { ownAlarms, parseAlarms, planRollback } from '../lambda/rollback/plan.js';
import { getConfig } from '../lib/config.js';
import { FrontendAlarmsStack } from '../lib/frontend-alarms-stack.js';

const NOW = new Date('2026-10-06T13:00:00.000Z');
const WINDOW = 30;

let seq = 0;
/** A record deployed `minutesAgo` before NOW, verified unless said otherwise. */
const rec = (releaseId: string, minutesAgo: number, extra: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  frontendName: 'frontend-user-dev',
  deployedAt: new Date(NOW.getTime() - minutesAgo * 60_000 + (seq++ % 1000)).toISOString(),
  releaseId,
  originPath: `/releases/${releaseId}`,
  distributionId: 'DIST',
  manifestKey: `frontend-user-dev/${releaseId}/manifest.json`,
  source: 'cicd',
  actor: 'github:someone',
  verifiedAt: '2026-10-06T00:00:00.000Z',
  ...extra,
});

const A = '20261006T100000Z';
const B = '20261006T110000Z';
const C = '20261006T124500Z';

test('rolls the latest release back to the newest earlier verified one', () => {
  const records = [rec(C, 10, { verifiedAt: undefined }), rec(B, 120), rec(A, 180)];
  const plan = planRollback(records, C, NOW, WINDOW);
  assert.equal(plan.action, 'rollback');
  assert.equal(plan.action === 'rollback' && plan.to.releaseId, B);
  assert.equal(plan.action === 'rollback' && plan.from.releaseId, C);
});

test('skips unverified targets and releases that were ever rolled back', () => {
  const records = [
    rec(C, 10),
    rec(B, 60, { source: 'restore', verifiedAt: undefined }),
    rec(B, 120, { rolledBackAt: '2026-10-06T11:05:00.000Z' }),
    rec(A, 180),
  ];
  const plan = planRollback(records, C, NOW, WINDOW);
  assert.equal(plan.action === 'rollback' && plan.to.releaseId, A);
});

test('never targets another record of the same release', () => {
  const plan = planRollback([rec(C, 10), rec(C, 100)], C, NOW, WINDOW);
  assert.deepEqual(plan, { action: 'skip', reason: 'no earlier verified release to roll back to' });
});

test('skips when there is nothing to roll back', () => {
  const skip = (records: DeploymentRecord[], live: string | undefined = records[0]?.releaseId) => {
    const plan = planRollback(records, live, NOW, WINDOW);
    assert.equal(plan.action, 'skip');
    return plan.action === 'skip' ? plan.reason : '';
  };
  assert.match(skip([]), /no deployments recorded/);
  assert.match(skip([rec(B, 5, { source: 'rollback' }), rec(C, 10)]), /already a rollback/);
  assert.match(skip([rec(B, 5, { source: 'restore' }), rec(C, 10)]), /already a restore/);
  assert.match(skip([rec(C, 5, { rolledBackAt: NOW.toISOString() }), rec(B, 60)]), /already rolled back/);
  assert.match(skip([rec(C, 45), rec(B, 120)]), /45 min old \(window: 30 min\)/);
  assert.match(skip([rec(C, 10), rec(B, 120)], B), /serves 20261006T110000Z, but the latest record is 20261006T124500Z/);
  assert.match(skip([rec(C, 10), rec(B, 120, { verifiedAt: undefined })]), /no earlier verified release/);
  // (an explicit undefined would take skip()'s default, so this case calls planRollback directly)
  assert.deepEqual(planRollback([rec(C, 10), rec(B, 120)], undefined, NOW, WINDOW), {
    action: 'skip', reason: 'the distribution serves no release, but the latest record is 20261006T124500Z',
  });
});

const snsEvent = (...messages: object[]) => ({
  Records: messages.map((m) => ({ Sns: { Message: JSON.stringify(m) } })),
}) as unknown as SNSEvent;

test('only reacts to ALARM transitions of its own alarms', () => {
  const alarms = parseAlarms(snsEvent(
    { AlarmName: 'rollback-factory-demo-frontend-4xx-rate-dev', NewStateValue: 'ALARM', NewStateReason: 'r' },
    { AlarmName: 'rollback-factory-demo-frontend-5xx-rate-dev', NewStateValue: 'OK', NewStateReason: 'r' },
    { AlarmName: 'rollback-factory-demo-4xx-rate-dev', NewStateValue: 'ALARM', NewStateReason: 'the API' },
  ));
  const own = ownAlarms(alarms, ['rollback-factory-demo-frontend-4xx-rate-dev', 'rollback-factory-demo-frontend-5xx-rate-dev']);
  assert.deepEqual(own.map((a) => a.alarmName), ['rollback-factory-demo-frontend-4xx-rate-dev']);
});

// --- Infrastructure -------------------------------------------------------------

const template = (() => {
  const app = new cdk.App();
  return Template.fromStack(new FrontendAlarmsStack(app, 'Test', {
    config: getConfig('dev', { rollbackWindowMinutes: 15 }),
    distributionId: 'E2EXAMPLE',
    mainRegion: 'eu-central-1',
    env: { account: '123456789012', region: 'us-east-1' },
  }));
})();

test('runs the rollback Lambda with the distribution, table and window it needs', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'rollback-factory-demo-frontend-rollback-dev',
    Runtime: 'nodejs24.x',
    Timeout: 30,
    Environment: {
      Variables: Match.objectLike({
        FRONTEND_NAME: 'frontend-user-dev',
        DISTRIBUTION_ID: 'E2EXAMPLE',
        DEPLOYMENTS_TABLE: 'rollback-factory-demo-frontend-deployments-dev',
        DEPLOYMENTS_TABLE_REGION: 'eu-central-1',
        ROLLBACK_WINDOW_MINUTES: '15',
        ALARM_NAMES: 'rollback-factory-demo-frontend-4xx-rate-dev,rollback-factory-demo-frontend-5xx-rate-dev',
      }),
    },
  });
  template.hasResource('AWS::Lambda::EventInvokeConfig', { Properties: Match.objectLike({ MaximumRetryAttempts: 0 }) });
});

test('subscribes the Lambda to its own two alarms only', () => {
  template.hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'lambda',
    FilterPolicyScope: 'MessageBody',
    FilterPolicy: { AlarmName: ['rollback-factory-demo-frontend-4xx-rate-dev', 'rollback-factory-demo-frontend-5xx-rate-dev'] },
  });
});

test('may only switch this distribution and write the table in the main region', () => {
  const [policy] = Object.values(template.findResources('AWS::IAM::Policy')) as any[];
  const statements: any[] = policy.Properties.PolicyDocument.Statement;
  const cloudfront = statements.find((s) => [s.Action].flat().includes('cloudfront:UpdateDistribution'));
  assert.deepEqual([cloudfront.Action].flat().sort(), ['cloudfront:CreateInvalidation', 'cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution']);
  assert.match(JSON.stringify(cloudfront.Resource), /:cloudfront::123456789012:distribution\/E2EXAMPLE/);
  const dynamo = statements.find((s) => [s.Action].flat().includes('dynamodb:PutItem'));
  assert.match(JSON.stringify(dynamo.Resource), /:dynamodb:eu-central-1:123456789012:table\/rollback-factory-demo-frontend-deployments-dev/);
});
