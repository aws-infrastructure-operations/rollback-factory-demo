import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DynamoDBDocumentClient, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  createDeploymentStore, DeploymentRecord, formatDuration, NewDeployment, retirement,
} from '../lambda/shared/deployments.js';

const deployment = (releaseId: string, extra: Partial<NewDeployment> = {}): NewDeployment => ({
  frontendName: 'frontend-user-dev',
  releaseId,
  originPath: `/releases/${releaseId}`,
  distributionId: 'DIST',
  manifestKey: `frontend-user-dev/${releaseId}/manifest.json`,
  source: 'cicd',
  actor: 'github:someone',
  ...extra,
});

const stored = (releaseId: string, deployedAt: string, extra: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  ...deployment(releaseId), deployedAt, current: true, ...extra,
});

/** A DynamoDB client whose Query returns `items`; records every command. */
const fakeDdb = (items: DeploymentRecord[] = [], fail?: (command: any) => Error | undefined) => {
  const sent: any[] = [];
  const client = {
    send: async (command: any) => {
      sent.push(command);
      const error = fail?.(command);
      if (error) throw error;
      if (command instanceof QueryCommand) return { Items: items.slice(0, command.input.Limit) };
      return {};
    },
  };
  const store = createDeploymentStore({
    table: 'rollback-factory-demo-frontend-deployments-dev',
    frontendName: 'frontend-user-dev',
    client: client as unknown as DynamoDBDocumentClient,
  });
  return { store, sent };
};

test('formats durations in days, hours and minutes', () => {
  assert.equal(formatDuration(45), '45 seconds');
  assert.equal(formatDuration(1), '1 second');
  assert.equal(formatDuration(9006), '2 hours 30 minutes');
  assert.equal(formatDuration(90061), '1 day 1 hour 1 minute');
});

test('retires a replaced deployment as stable for its lifetime', () => {
  const previous = stored('20261006T120000Z', '2026-10-06T12:00:00.000Z');
  assert.deepEqual(retirement(previous, { deployedAt: '2026-10-06T14:30:00.000Z' }), {
    current: false, stable: true, stableFor: 9000, stableForHumanReadable: '2 hours 30 minutes',
  });
});

test('retires a rolled-back deployment as unstable', () => {
  const previous = stored('20261006T120000Z', '2026-10-06T12:00:00.000Z', { rolledBackAt: '2026-10-06T12:05:00.000Z' });
  assert.deepEqual(retirement(previous, { deployedAt: '2026-10-06T12:06:00.000Z' }), { current: false, stable: false });
});

test('the first record is a plain conditional put, marked current', async () => {
  const { store, sent } = fakeDdb();
  const now = new Date('2026-10-06T12:30:05.000Z');

  const record = await store.record(deployment('20261006T123005Z'), { now });

  assert.equal(record?.deployedAt, '2026-10-06T12:30:05.000Z');
  assert.equal(record?.current, true);
  const put: any = sent.find((c) => c instanceof PutCommand);
  assert.equal(put.input.TableName, 'rollback-factory-demo-frontend-deployments-dev');
  assert.equal(put.input.Item.frontendName, 'frontend-user-dev');
  assert.equal(put.input.ConditionExpression, 'attribute_not_exists(deployedAt)');
});

test('a new release replaces the current one in one transaction', async () => {
  const previous = stored('20261006T120000Z', '2026-10-06T12:00:00.000Z');
  const { store, sent } = fakeDdb([previous]);

  await store.record(deployment('20261006T123005Z'), { now: new Date('2026-10-06T12:30:05.000Z') });

  const tx: any = sent.find((c) => c instanceof TransactWriteCommand);
  const [put, update] = tx.input.TransactItems;
  assert.equal(put.Put.Item.releaseId, '20261006T123005Z');
  assert.deepEqual(update.Update.Key, { frontendName: 'frontend-user-dev', deployedAt: previous.deployedAt });
  assert.deepEqual(update.Update.ExpressionAttributeValues, {
    ':false': false, ':stable': true, ':stableFor': 1805, ':stableForHumanReadable': '30 minutes',
  });
});

test('records nothing when the latest record already has the release, unless forced', async () => {
  const latest = stored('20261006T123005Z', '2026-10-06T12:30:05.000Z');
  const { store, sent } = fakeDdb([latest]);

  assert.equal(await store.record(deployment('20261006T123005Z')), undefined);
  assert.equal(sent.some((c) => c instanceof TransactWriteCommand), false);
  assert.ok(await store.record(deployment('20261006T123005Z'), { force: true }));
});

test('lists newest first for this frontend', async () => {
  const { store, sent } = fakeDdb();
  await store.list(5);
  assert.deepEqual(sent[0].input, {
    TableName: 'rollback-factory-demo-frontend-deployments-dev',
    KeyConditionExpression: 'frontendName = :name',
    ExpressionAttributeValues: { ':name': 'frontend-user-dev' },
    ScanIndexForward: false,
    Limit: 5,
  });
});

test('marks a deployment verified', async () => {
  const { store, sent } = fakeDdb();
  await store.markVerified(stored('20261006T123005Z', '2026-10-06T12:30:05.000Z'), new Date('2026-10-06T12:40:00.000Z'));
  const update: any = sent.find((c) => c instanceof UpdateCommand);
  assert.equal(update.input.UpdateExpression, 'SET verifiedAt = :now');
  assert.deepEqual(update.input.ExpressionAttributeValues, { ':now': '2026-10-06T12:40:00.000Z' });
});

test('only one rollback can claim a deployment', async () => {
  const conditionFailed = Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
  const record = stored('20261006T123005Z', '2026-10-06T12:30:05.000Z');

  const first = fakeDdb();
  assert.equal(await first.store.claimRollback(record), true);
  assert.match(first.sent[0].input.ConditionExpression, /attribute_not_exists\(rolledBackAt\)/);

  const second = fakeDdb([], () => conditionFailed);
  assert.equal(await second.store.claimRollback(record), false);

  const broken = fakeDdb([], () => new Error('throttled'));
  await assert.rejects(broken.store.claimRollback(record), /throttled/);
});
