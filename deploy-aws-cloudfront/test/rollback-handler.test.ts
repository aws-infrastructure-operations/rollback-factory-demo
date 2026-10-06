import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import type { SNSEvent } from 'aws-lambda';
import {
  CloudFrontClient, CreateInvalidationCommand, GetDistributionConfigCommand, UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  DynamoDBDocumentClient, QueryCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DeploymentRecord } from '../lambda/shared/deployments.js';

Object.assign(process.env, {
  FRONTEND_NAME: 'frontend-user-dev',
  DISTRIBUTION_ID: 'DIST',
  DEPLOYMENTS_TABLE: 'rollback-factory-demo-frontend-deployments-dev',
  DEPLOYMENTS_TABLE_REGION: 'eu-central-1',
  ROLLBACK_WINDOW_MINUTES: '30',
  ALARM_NAMES: 'rollback-factory-demo-frontend-4xx-rate-dev,rollback-factory-demo-frontend-5xx-rate-dev',
  AWS_REGION: 'us-east-1',
});

const BAD = '20261006T124500Z';
const GOOD = '20261006T110000Z';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const record = (releaseId: string, deployedAt: string, extra: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  frontendName: 'frontend-user-dev',
  deployedAt,
  releaseId,
  originPath: `/releases/${releaseId}`,
  distributionId: 'DIST',
  manifestKey: `frontend-user-dev/${releaseId}/manifest.json`,
  source: 'cicd',
  actor: 'github:someone',
  ...extra,
});

/** The fake AWS: a deployment history, a distribution serving `live`, and every call made. */
let history: DeploymentRecord[];
let live: string;
let claimTaken: boolean;
let calls: any[];

beforeEach(() => {
  history = [
    record(BAD, minutesAgo(5)),
    record(GOOD, minutesAgo(120), { verifiedAt: minutesAgo(110), commit: 'abc1234' }),
  ];
  live = BAD;
  claimTaken = false;
  calls = [];
});

CloudFrontClient.prototype.send = (async (command: any) => {
  calls.push(command);
  if (command instanceof GetDistributionConfigCommand) {
    return { ETag: 'etag', DistributionConfig: { Origins: { Quantity: 1, Items: [{ Id: 's3', OriginPath: `/releases/${live}` }] } } };
  }
  if (command instanceof UpdateDistributionCommand) {
    live = command.input.DistributionConfig!.Origins!.Items![0].OriginPath!.split('/').pop()!;
    return {};
  }
  if (command instanceof CreateInvalidationCommand) return { Invalidation: { Id: 'INV' } };
  throw new Error(`unexpected ${command.constructor.name}`);
}) as any;

DynamoDBDocumentClient.prototype.send = (async (command: any) => {
  calls.push(command);
  if (command instanceof QueryCommand) return { Items: history.slice(0, command.input.Limit) };
  if (command instanceof UpdateCommand && command.input.UpdateExpression?.includes('rolledBackAt')) {
    if (claimTaken) throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
    claimTaken = true;
    const claimed = history.find((r) => r.deployedAt === command.input.Key!.deployedAt)!;
    claimed.rolledBackAt = new Date().toISOString();
    return {};
  }
  if (command instanceof TransactWriteCommand) return {};
  throw new Error(`unexpected ${command.constructor.name}`);
}) as any;

const alarm = (name: string, state = 'ALARM') => ({
  Records: [{ Sns: { Message: JSON.stringify({ AlarmName: name, NewStateValue: state, NewStateReason: 'test' }) } }],
}) as unknown as SNSEvent;

const load = async () => (await import('../lambda/rollback/handler.js')).handler;

test('switches back to the verified release, invalidates and records the rollback', async () => {
  const handler = await load();
  const result = await handler(alarm('rollback-factory-demo-frontend-5xx-rate-dev'));

  assert.deepEqual({ ...result, deployedAt: undefined }, {
    action: 'rolledBack', from: BAD, to: GOOD, invalidationId: 'INV', deployedAt: undefined,
  });
  assert.equal(live, GOOD);
  const tx: any = calls.find((c) => c instanceof TransactWriteCommand);
  const item = tx.input.TransactItems[0].Put.Item;
  assert.equal(item.releaseId, GOOD);
  assert.equal(item.source, 'rollback');
  assert.equal(item.actor, 'alarm:rollback-factory-demo-frontend-5xx-rate-dev');
  assert.equal(item.rolledBackFrom, history[0].deployedAt);
  assert.equal(item.previousReleaseId, BAD);
  assert.equal(item.verifiedAt, history[1].verifiedAt);
  assert.equal(item.commit, 'abc1234');
  assert.equal(item.invalidationId, 'INV');
  // the rolled-back deployment is retired as unstable
  assert.deepEqual(tx.input.TransactItems[1].Update.Key, { frontendName: 'frontend-user-dev', deployedAt: history[0].deployedAt });
  assert.equal(tx.input.TransactItems[1].Update.ExpressionAttributeValues[':stable'], false);
});

test('a second alarm loses the claim and changes nothing', async () => {
  const handler = await load();
  claimTaken = true;
  const result = await handler(alarm('rollback-factory-demo-frontend-4xx-rate-dev'));
  assert.deepEqual(result, { action: 'skip', reason: 'already claimed' });
  assert.equal(live, BAD);
  assert.equal(calls.some((c) => c instanceof UpdateDistributionCommand), false);
});

test('ignores other alarms and OK transitions without touching AWS', async () => {
  const handler = await load();
  assert.equal((await handler(alarm('rollback-factory-demo-4xx-rate-dev'))).action, 'skip');
  assert.equal((await handler(alarm('rollback-factory-demo-frontend-4xx-rate-dev', 'OK'))).action, 'skip');
  assert.deepEqual(calls, []);
});

test('skips when the live release is not the latest record', async () => {
  const handler = await load();
  live = GOOD;
  const result = await handler(alarm('rollback-factory-demo-frontend-4xx-rate-dev'));
  assert.equal(result.action, 'skip');
  assert.equal(calls.some((c) => c instanceof UpdateCommand), false, 'nothing claimed');
});
