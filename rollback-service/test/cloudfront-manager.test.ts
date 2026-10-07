// CloudFront manager end to end, with CloudFront and DynamoDB stubbed.
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import {
  CloudFrontClient, CreateInvalidationCommand, GetDistributionConfigCommand, UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DeploymentRecord } from '../lambda/managers/cloudfront/deployments.js';
import { handleAlarm, restore, type CloudFrontRollbackTarget } from '../lambda/managers/cloudfront/manager.js';

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
      // the dashboard API's origin comes first: the rollback must switch the site origin and leave it alone
      return { ETag: 'etag', DistributionConfig: { Origins: { Quantity: 2, Items: [
        { Id: 'api', DomainName: 'abc123.lambda-url.eu-central-1.on.aws', OriginPath: '' },
        { Id: 's3', DomainName: 'site.s3.eu-central-1.amazonaws.com', OriginPath: `/releases/${live}` },
      ] } } };
    }
    if (command instanceof UpdateDistributionCommand) {
      const [api, site] = command.input.DistributionConfig!.Origins!.Items!;
      assert.equal(api.OriginPath, '', 'the API origin keeps its path');
      live = site.OriginPath!.split('/').pop()!;
      return {};
    }
    if (command instanceof CreateInvalidationCommand) return { Invalidation: { Id: 'INV' } };
    throw new Error(`unexpected ${command.constructor.name}`);
  },
} as unknown as CloudFrontClient;

DynamoDBDocumentClient.prototype.send = (async (command: any) => {
  calls.push(command);
  if (command instanceof QueryCommand) return { Items: history.slice(0, command.input.Limit) };
  if (command instanceof GetCommand) return { Item: history.find((r) => r.deployedAt === command.input.Key!.deployedAt) };
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

// --- Restore (the dashboard's Restore button) -----------------------------------------------------

test('restores a chosen release: switches the site origin, invalidates and records an unverified restore', async () => {
  const chosen = history[1];
  const result = await restore(TARGET, { deployedAt: chosen.deployedAt, reason: 'bad banner', actor: 'dashboard' }, { client: cloudfront });
  assert.deepEqual({ ...result, deployedAt: undefined }, {
    action: 'restored', from: BAD, to: GOOD, invalidationId: 'INV', deployedAt: undefined,
  });
  assert.equal(live, GOOD);
  const tx: any = calls.find((x) => x instanceof TransactWriteCommand);
  const item = tx.input.TransactItems[0].Put.Item;
  assert.equal(item.source, 'restore');
  assert.equal(item.actor, 'dashboard');
  assert.equal(item.releaseId, GOOD);
  assert.equal(item.commit, 'abc1234');
  assert.equal(item.verifiedAt, undefined, 'verified only once the integration tests pass again');
  assert.match(item.description, /^Restore to 20261006T110000Z .*: bad banner$/);
  assert.equal(calls.some((x) => x instanceof UpdateCommand && x.input.UpdateExpression?.includes('rolledBackAt')), false, 'no claim');
});

test('a restore of the live release changes nothing', async () => {
  const result = await restore(TARGET, { deployedAt: history[0].deployedAt }, { client: cloudfront });
  assert.equal(result.action, 'skip');
  assert.equal(live, BAD);
  assert.equal(calls.some((x) => x instanceof UpdateDistributionCommand || x instanceof TransactWriteCommand), false);
});

test('refuses a record that does not exist or belongs to another distribution', async () => {
  await assert.rejects(restore(TARGET, { deployedAt: '2020-01-01T00:00:00.000Z' }, { client: cloudfront }), /No release of frontend-user-dev/);
  history[1].distributionId = 'OLD-DIST';
  await assert.rejects(restore(TARGET, { deployedAt: history[1].deployedAt }, { client: cloudfront }), /No release/);
  assert.equal(live, BAD);
});
