import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { functionFromAlarm, rollbackGuard, stableFor } from '../lambda/rollback/rollback.js';
import type { Registration } from '../lambda/rollback/registry.js';
import { sessionPolicy } from '../lambda/rollback/scoped.js';
import { formatDuration, s3Key, versionSk } from '../lambda/rollback/util.js';

const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const registration: Registration = {
  name: 'service-lambda-dev', alias: 'live', alarms: new Set(['a']), maxConsecutiveRollbacks: 2, deploymentWindowMinutes: 10,
};
const guard = (state: Parameters<typeof rollbackGuard>[0]) => rollbackGuard(state, registration, 'fn:live v5', NOW, 3 * 60_000);

test('keys: zero-padded version sort keys and one zip per version', () => {
  assert.equal(versionSk(3), 'VERSION#0000000003');
  assert.equal(s3Key('service-lambda-dev', 12), 'service-lambda-dev/service-lambda-dev-12.zip');
});

test('formats durations like the original', () => {
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(93784), '1d 2h 3m');
  assert.equal(formatDuration(9000), '2h 30m');
});

test('finds the function in single-metric and metric-math alarms', () => {
  assert.equal(functionFromAlarm({ AlarmName: 'a', NewStateValue: 'ALARM', Trigger: { Dimensions: [{ name: 'FunctionName', value: 'fn' }] } }), 'fn');
  assert.equal(functionFromAlarm({
    AlarmName: 'a', NewStateValue: 'ALARM',
    Trigger: { Metrics: [{}, { MetricStat: { Metric: { Dimensions: [{ Name: 'Resource', Value: 'fn:live' }, { Name: 'FunctionName', Value: 'fn' }] } } }] },
  }), 'fn');
  assert.equal(functionFromAlarm({ AlarmName: 'a', NewStateValue: 'ALARM' }), undefined);
});

test('guards: rolls back a recent deploy within the limits', () => {
  assert.equal(guard({ version: 5, rollbackCount: 0, stable: false, updatedBy: 'deploy', updatedAt: minutesAgo(2) }), undefined);
});

test('guards: no rollback outside the deployment window', () => {
  assert.match(guard({ version: 5, rollbackCount: 0, stable: false, updatedBy: 'deploy', updatedAt: minutesAgo(30) })!,
    /no deploy or rollback in the last 10 min \(last deploy 30 min ago\)/);
  assert.match(guard(undefined)!, /no deploy or rollback recorded/);
});

test('guards: cooldown after a rollback or a $LATEST-only revert', () => {
  const base = { version: 5, rollbackCount: 1, stable: false, updatedAt: minutesAgo(1) };
  assert.match(guard({ ...base, lastRollbackAt: minutesAgo(1) })!, /rolled back 60s ago/);
  assert.match(guard({ ...base, rollbackCount: 0, lastLatestRevertAt: minutesAgo(2) })!, /had \$LATEST reverted 120s ago/);
  assert.equal(guard({ ...base, lastRollbackAt: minutesAgo(4) }), undefined);
});

test('guards: stops after maxConsecutiveRollbacks', () => {
  assert.match(guard({ version: 5, rollbackCount: 2, stable: false, updatedAt: minutesAgo(5), lastRollbackAt: minutesAgo(5) })!,
    /already rolled back 2 times in a row \(max 2\)/);
});

test('stableFor: from stableAt to now, or a note when it was never stable', () => {
  assert.deepEqual(stableFor({ stable: true, stableAt: '2026-10-06T09:30:00.000Z' }, '2026-10-06T12:00:00.000Z'),
    { stableForSeconds: 9000, stableFor: '2h 30m' });
  assert.deepEqual(stableFor({ stable: false }, '2026-10-06T12:00:00.000Z'),
    { stableForSeconds: 0, stableFor: 'not marked stable while live' });
  assert.deepEqual(stableFor(undefined, '2026-10-06T12:00:00.000Z').stableForSeconds, 0);
});

test('the session policy scopes credentials to one function, its folder and its items', () => {
  const policy = sessionPolicy('service-lambda-dev', {
    roleArn: 'r',
    functionArnPrefix: 'arn:aws:lambda:eu-central-1:123456789012:function:',
    tableArn: 'arn:aws:dynamodb:eu-central-1:123456789012:table/t',
    bucketName: 'bucket',
  });
  const [fn, s3, ddb] = policy.Statement;
  assert.deepEqual(fn.Resource, [
    'arn:aws:lambda:eu-central-1:123456789012:function:service-lambda-dev',
    'arn:aws:lambda:eu-central-1:123456789012:function:service-lambda-dev:*',
  ]);
  assert.equal(s3.Resource, 'arn:aws:s3:::bucket/service-lambda-dev/*');
  assert.deepEqual(ddb.Condition, { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['service-lambda-dev'] } });
});
