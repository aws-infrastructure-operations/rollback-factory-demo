// CloudFront manager: deciding what to roll back to.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SNSEvent } from 'aws-lambda';
import type { DeploymentRecord } from '../lambda/managers/cloudfront/deployments.js';
import { ownAlarms, parseAlarms, planRollback } from '../lambda/managers/cloudfront/plan.js';

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
    { AlarmName: 'rollback-factory-demo-cloudfront-frontend-user-4xx-rate-dev', NewStateValue: 'ALARM', NewStateReason: 'r' },
    { AlarmName: 'rollback-factory-demo-cloudfront-frontend-user-5xx-rate-dev', NewStateValue: 'OK', NewStateReason: 'r' },
    { AlarmName: 'rollback-factory-demo-apigateway-api-user-4xx-rate-dev', NewStateValue: 'ALARM', NewStateReason: 'the API' },
  ));
  const own = ownAlarms(alarms, ['rollback-factory-demo-cloudfront-frontend-user-4xx-rate-dev', 'rollback-factory-demo-cloudfront-frontend-user-5xx-rate-dev']);
  assert.deepEqual(own.map((a) => a.alarmName), ['rollback-factory-demo-cloudfront-frontend-user-4xx-rate-dev']);
});
