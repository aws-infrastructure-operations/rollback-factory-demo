// End-to-end tests of the rollback system against an in-memory fake of Lambda, DynamoDB, S3 and
// CloudWatch: sync/archive, alarm rollback, guards, $LATEST-only revert and the scheduled check.
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  GetAliasCommand, GetFunctionCommand, LambdaClient, ListVersionsByFunctionCommand, UpdateAliasCommand,
  UpdateFunctionCodeCommand,
} from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { resolveRegistry } from '../lambda/rollback/registry.js';
import { createRollbackSystem } from '../lambda/rollback/rollback.js';

const FN = 'service-lambda-dev';
const ALARM = 'rollback-factory-demo-service-lambda-errors-dev';
const TABLE = 'versions';
const BUCKET = 'artifacts';
const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

// --- fake DynamoDB (just the expressions the rollback system uses) ---------------------------------
type Item = Record<string, AttributeValue>;
const conditionFailed = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

class FakeTable {
  items = new Map<string, Item>();
  key = (k: Item) => `${k.functionName.S}|${k.sk.S}`;
  get = (sk: string) => this.items.get(`${FN}|${sk}`);

  check(item: Item | undefined, expr: string | undefined, values: Record<string, AttributeValue> = {}) {
    if (!expr) return;
    const ok = expr === 'attribute_exists(sk)' ? !!item
      : expr === 'attribute_not_exists(sk)' ? !item
        : expr === 'version = :seen' ? item?.version?.N === values[':seen'].N
          : expr === 'version = :version' ? item?.version?.N === values[':version'].N
            : (() => { throw new Error(`fake table: unsupported condition ${expr}`); })();
    if (!ok) throw conditionFailed();
  }

  send(command: any) {
    const input = command.input;
    if (command instanceof GetItemCommand) return { Item: this.items.get(this.key(input.Key)) };
    if (command instanceof PutItemCommand) {
      this.check(this.items.get(this.key(input.Item)), input.ConditionExpression, input.ExpressionAttributeValues);
      this.items.set(this.key(input.Item), structuredClone(input.Item));
      return {};
    }
    if (command instanceof UpdateItemCommand) {
      const existing = this.items.get(this.key(input.Key));
      this.check(existing, input.ConditionExpression, input.ExpressionAttributeValues);
      const item: Item = structuredClone(existing ?? input.Key);
      const assignments = input.UpdateExpression.replace(/^SET /, '').split(/,\s*(?![^(]*\))/);
      for (const assignment of assignments) {
        const [name, value] = assignment.split(/\s*=\s*/);
        const ifNotExists = /^if_not_exists\((\w+),\s*(:\w+)\)$/.exec(value);
        item[name] = ifNotExists ? (item[ifNotExists[1]] ?? input.ExpressionAttributeValues[ifNotExists[2]]) : input.ExpressionAttributeValues[value];
      }
      this.items.set(this.key(input.Key), item);
      return {};
    }
    if (command instanceof QueryCommand) {
      const fn = input.ExpressionAttributeValues[':f'].S;
      const items = [...this.items.values()]
        .filter((i) => i.functionName.S === fn && i.sk.S!.startsWith('VERSION#'))
        .sort((a, b) => a.sk.S!.localeCompare(b.sk.S!));
      return { Items: input.ScanIndexForward === false ? items.reverse() : items };
    }
    throw new Error(`fake table: unexpected ${command.constructor.name}`);
  }
}

// --- fake Lambda function ----------------------------------------------------------------
class FakeFunction {
  versions = new Map<number, { sha: string; description: string }>();
  live = { version: 1, revision: 'r1' };
  latest = { sha: 'sha-1', lastModified: minutesAgo(60) };
  calls: any[] = [];

  publish(version: number) {
    this.versions.set(version, { sha: `sha-${version}`, description: `commit ${version}` });
    this.latest = { sha: `sha-${version}`, lastModified: new Date(NOW).toISOString() };
  }

  send(command: any) {
    this.calls.push(command);
    const input = command.input;
    if (command instanceof ListVersionsByFunctionCommand) {
      return { Versions: [{ Version: '$LATEST' }, ...[...this.versions.keys()].map((v) => ({ Version: String(v) }))] };
    }
    if (command instanceof GetFunctionCommand) {
      if (!input.Qualifier) return { Configuration: { CodeSha256: this.latest.sha, LastModified: this.latest.lastModified.replace('Z', '+0000') } };
      const v = this.versions.get(Number(input.Qualifier))!;
      return {
        Code: { Location: `https://code.example/${input.Qualifier}` },
        Configuration: {
          CodeSha256: v.sha, Description: v.description, LastModified: minutesAgo(30), Runtime: 'nodejs24.x',
          Handler: 'index.handler', MemorySize: 128, Timeout: 3, CodeSize: 100, PackageType: 'Zip',
        },
      };
    }
    if (command instanceof GetAliasCommand) return { FunctionVersion: String(this.live.version), RevisionId: this.live.revision };
    if (command instanceof UpdateAliasCommand) {
      if (input.RevisionId !== this.live.revision) throw new Error('PreconditionFailedException');
      this.live = { version: Number(input.FunctionVersion), revision: `${this.live.revision}+` };
      return {};
    }
    if (command instanceof UpdateFunctionCodeCommand) {
      const version = Number(/-(\d+)\.zip$/.exec(input.S3Key)![1]);
      this.latest = { sha: this.versions.get(version)!.sha, lastModified: new Date(NOW).toISOString() };
      return { CodeSha256: this.latest.sha };
    }
    throw new Error(`fake lambda: unexpected ${command.constructor.name}`);
  }
}

let table: FakeTable;
let fn: FakeFunction;
let uploads: string[];
let alarmState: string;
let aliasErrors: number;

const system = () => createRollbackSystem({
  cloudwatch: {
    send: async (command: any) => {
      if (command instanceof DescribeAlarmsCommand) {
        return { MetricAlarms: [{
          AlarmName: ALARM, StateValue: alarmState,
          Metrics: [{ MetricStat: { Metric: { Dimensions: [{ Name: 'FunctionName', Value: FN }] } } }],
        }] };
      }
      if (command instanceof GetMetricDataCommand) return { MetricDataResults: [{ Values: [aliasErrors] }] };
      throw new Error('fake cloudwatch: unexpected command');
    },
  } as unknown as CloudWatchClient,
  scopedClients: async () => ({
    lambda: { send: async (c: any) => fn.send(c) } as unknown as LambdaClient,
    ddb: { send: async (c: any) => table.send(c) } as unknown as DynamoDBClient,
    s3: { send: async (c: any) => { if (c instanceof PutObjectCommand) uploads.push(c.input.Key!); return {}; } } as unknown as S3Client,
  }),
  fetch: (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch,
  waitForUpdate: async () => {},
  now: () => NOW,
}, {
  tableName: TABLE,
  bucketName: BUCKET,
  registry: resolveRegistry({ functions: [{ name: 'service-lambda-<env>', alarms: [ALARM] }] }, 'dev'),
  cooldownMs: 3 * 60_000,
  stableAfterMs: 5 * 60_000,
  liveErrorsLookbackMs: 5 * 60_000,
});

const alarmEvent = (name = ALARM, state = 'ALARM') => ({
  Records: [{ Sns: { Message: JSON.stringify({ AlarmName: name, NewStateValue: state, Trigger: { Dimensions: [{ name: 'FunctionName', value: FN }] } }) } }],
});

/** v1 was live, then v2 failed its integration tests (published, never live), then v3 was promoted. */
async function deployHistory() {
  const handle = system();
  fn.publish(1);
  await handle({ type: 'sync' }); // v1 live
  fn.publish(2); // integration tests failed: live stays on v1
  fn.publish(3);
  fn.live = { version: 3, revision: 'r3' }; // promoted
  await handle({ type: 'sync', functionName: FN });
  table.get('CURRENT')!.updatedAt = { S: minutesAgo(2) };
  return handle;
}

beforeEach(() => {
  table = new FakeTable();
  fn = new FakeFunction();
  uploads = [];
  alarmState = 'OK';
  aliasErrors = 1;
});

test('sync archives every published version once and records the live version as a deploy', async () => {
  const handle = system();
  fn.publish(1);
  fn.publish(2);
  fn.live = { version: 2, revision: 'r2' };

  assert.deepEqual(await handle({ type: 'sync' }), [{ functionName: FN, synced: true, archived: [1, 2], currentVersion: 2 }]);
  assert.deepEqual(uploads, [`${FN}/${FN}-1.zip`, `${FN}/${FN}-2.zip`]);
  assert.equal(table.get('VERSION#0000000002')!.description.S, 'commit 2');
  const current = table.get('CURRENT')!;
  assert.equal(current.version.N, '2');
  assert.equal(current.updatedBy.S, 'deploy');
  assert.equal(table.get('VERSION#0000000002')!.liveAt?.S, new Date(NOW).toISOString(), 'promoted version marked live');
  assert.equal(table.get('VERSION#0000000001')!.liveAt, undefined, 'never live');

  assert.deepEqual(await handle({ type: 'sync' }), [{ functionName: FN, synced: true, archived: [], currentVersion: 2 }]);
});

test('sync of an unregistered function is skipped', async () => {
  assert.deepEqual(await system()({ type: 'sync', functionName: 'other' }), [
    { rolledBack: false, reason: 'other is not registered for rollback (see rollback-config.json)' },
  ]);
});

test('an alarm rolls live back to the previous version that was live, skipping one that failed its tests', async () => {
  const handle = await deployHistory();
  const [result] = await handle(alarmEvent()) as any[];

  assert.deepEqual(result, {
    rolledBack: true, functionName: FN, aliasName: 'live', from: 3, to: 1, rollbackNumber: 1,
    restoredFrom: `s3://${BUCKET}/${FN}/${FN}-1.zip`,
  });
  assert.equal(fn.live.version, 1);
  assert.equal(fn.latest.sha, 'sha-1', '$LATEST restored from the archived zip');
  const update: any = fn.calls.find((c) => c instanceof UpdateAliasCommand);
  assert.equal(update.input.RevisionId, 'r3', 'conditional on the alias revision');

  const current = table.get('CURRENT')!;
  assert.equal(current.version.N, '1');
  assert.equal(current.previousVersion.N, '3');
  assert.equal(current.updatedBy.S, 'auto-rollback');
  assert.equal(current.rollbackCount.N, '1');
  const from = table.get('VERSION#0000000003')!;
  assert.equal(from.rolledBackBy.S, 'auto-rollback');
  assert.equal(from.rollbackReason.S, `alarm ${ALARM}`);
  assert.equal(from.stable.BOOL, false);
  assert.equal(from.stableFor.S, 'not marked stable while live');
});

test('a version that was rolled back from is never a target again', async () => {
  const handle = await deployHistory();
  table.get('VERSION#0000000001')!.rolledBackAt = { S: minutesAgo(100) };
  const [result] = await handle(alarmEvent()) as any[];
  assert.deepEqual(result, { rolledBack: false, reason: `${FN}:live is on version 3, no older version that was live to roll back to` });
  assert.equal(fn.live.version, 3);
});

test('guards stop a rollback outside the deployment window', async () => {
  const handle = await deployHistory();
  table.get('CURRENT')!.updatedAt = { S: minutesAgo(30) };
  const [result] = await handle(alarmEvent()) as any[];
  assert.equal(result.rolledBack, false);
  assert.match(result.reason, /no deploy or rollback in the last 10 min/);
  assert.equal(fn.live.version, 3);
});

test('alarms that are not registered for the function are skipped', async () => {
  const handle = await deployHistory();
  const [result] = await handle(alarmEvent('some-other-alarm')) as any[];
  assert.deepEqual(result, { rolledBack: false, reason: `alarm 'some-other-alarm' is not registered for ${FN} (see rollback-config.json)` });
  const [ok] = await handle(alarmEvent(ALARM, 'OK')) as any[];
  assert.deepEqual(ok, { rolledBack: false, reason: 'state is OK, not ALARM' });
});

test('a $LATEST-only failure reverts $LATEST and leaves the healthy alias alone', async () => {
  const handle = await deployHistory();
  fn.versions.set(99, { sha: 'sha-bad', description: 'unpublished' });
  fn.latest = { sha: 'sha-bad', lastModified: minutesAgo(1) }; // new code on $LATEST, alias untouched
  aliasErrors = 0;

  const [result] = await handle(alarmEvent()) as any[];
  assert.deepEqual(result, {
    rolledBack: true, latestOnly: true, functionName: FN, aliasName: 'live', from: '$LATEST', to: 3,
    restoredFrom: `s3://${BUCKET}/${FN}/${FN}-3.zip`,
  });
  assert.equal(fn.live.version, 3, 'alias not moved');
  assert.equal(fn.latest.sha, 'sha-3');
  const current = table.get('CURRENT')!;
  assert.equal(current.latestRevertedFromSha.S, 'sha-bad');
  assert.equal(current.latestRevertedToVersion.N, '3');
  assert.equal(current.rollbackCount.N, '0', 'does not count towards the limit');
});

test('the scheduled check marks the live version stable once its alarms stayed OK long enough', async () => {
  const handle = await deployHistory();
  table.get('CURRENT')!.updatedAt = { S: minutesAgo(6) };
  alarmState = 'OK';

  const results = await handle({ type: 'scheduled-check' }) as any[];
  assert.deepEqual(results[0], { functionName: FN, version: 3, stable: true });
  assert.equal(table.get('CURRENT')!.stable.BOOL, true);
  assert.equal(table.get('VERSION#0000000003')!.stable.BOOL, true);
});

test('the scheduled check re-handles an alarm still in ALARM', async () => {
  const handle = await deployHistory();
  alarmState = 'ALARM';
  const results = await handle({ type: 'scheduled-check' }) as any[];
  assert.deepEqual(results.map((r) => r.rolledBack), [true]);
  assert.equal(fn.live.version, 1);
});
