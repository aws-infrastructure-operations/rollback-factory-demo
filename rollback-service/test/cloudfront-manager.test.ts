// CloudFront manager end to end, with CloudFront and DynamoDB stubbed.
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import {
  CloudFrontClient, CreateInvalidationCommand, GetDistributionConfigCommand, UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DeploymentRecord } from '../lambda/managers/cloudfront/deployments.js';
import { handleAlarm, type CloudFrontRollbackTarget } from '../lambda/managers/cloudfront/manager.js';

const ALARM = 'rollback-factory-demo-cloudfront-frontend-user-5xx-rate-dev';
const TARGET: CloudFrontRollbackTarget = {
  frontendName: 'frontend-user-dev',
  distributionId: 'DIST',
  table: 'rollback-factory-demo-frontend-deployments-dev',
  alarmNames: ['rollback-factory-demo-cloudfront-frontend-user-4xx-rate-dev', ALARM],
  rollbackWindowMinutes: 30,
};
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

const cloudfront = {
  send: async (command: any) => {
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
  },
} as unknown as CloudFrontClient;

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

const alarm = (name = ALARM, newState = 'ALARM') => ({ alarmName: name, newState, reason: 'test' });

test('switches back to the verified release, invalidates and records the rollback', async () => {
  const result = await handleAlarm(TARGET, alarm(), { client: cloudfront });
  assert.deepEqual({ ...result, deployedAt: undefined }, {
    action: 'rolledBack', from: BAD, to: GOOD, invalidationId: 'INV', deployedAt: undefined,
  });
  assert.equal(live, GOOD);
  const tx: any = calls.find((c) => c instanceof TransactWriteCommand);
  const item = tx.input.TransactItems[0].Put.Item;
  assert.equal(item.releaseId, GOOD);
  assert.equal(item.source, 'rollback');
  assert.equal(item.actor, `alarm:${ALARM}`);
  assert.equal(item.verifiedAt, history[1].verifiedAt);
  assert.equal(item.commit, 'abc1234');
  assert.equal(tx.input.TransactItems[1].Update.ExpressionAttributeValues[':stable'], false);
});

test('a second alarm loses the claim and changes nothing', async () => {
  claimTaken = true;
  assert.deepEqual(await handleAlarm(TARGET, alarm(), { client: cloudfront }), { action: 'skip', reason: 'already claimed' });
  assert.equal(live, BAD);
});

test('ignores alarms that are not this target\'s and OK transitions, without touching AWS', async () => {
  assert.equal((await handleAlarm(TARGET, alarm('rollback-factory-demo-cloudfront-other-4xx-rate-dev'), { client: cloudfront })).action, 'skip');
  assert.equal((await handleAlarm(TARGET, alarm(ALARM, 'OK'), { client: cloudfront })).action, 'skip');
  assert.deepEqual(calls, []);
});

test('skips when the live release is not the latest record', async () => {
  live = GOOD;
  assert.equal((await handleAlarm(TARGET, alarm(), { client: cloudfront })).action, 'skip');
  assert.equal(calls.some((c) => c instanceof UpdateCommand), false, 'nothing claimed');
});
