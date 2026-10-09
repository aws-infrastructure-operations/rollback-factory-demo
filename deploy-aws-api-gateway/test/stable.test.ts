import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { DeploymentRecord } from '../lambda/shared/deployments.js';
import { latestStable } from '../scripts/lib/stable.js';

const record = (deployedAt: string, extra: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  apiName: 'api-user-dev',
  deployedAt,
  restApiId: 'abc',
  stageName: 'v1',
  deploymentId: `d-${deployedAt}`,
  specBucket: 'bucket',
  specKey: `api-user-dev/${deployedAt}/openapi.json`,
  source: 'cicd',
  actor: 'github:someone',
  ...extra,
});

const failed = '2026-10-09T12:00:00.000Z';

test('picks the newest earlier deployment that was verified and retired without a rollback', () => {
  const records = [
    record(failed, { current: true }),
    record('2026-10-09T11:00:00.000Z', { verifiedAt: 'x', current: false, stable: true }),
    record('2026-10-09T10:00:00.000Z', { verifiedAt: 'x', current: false, stable: true }),
  ];
  assert.equal(latestStable(records, failed)?.deployedAt, '2026-10-09T11:00:00.000Z');
});

test('skips unverified, rolled back and unstable deployments', () => {
  const records = [
    record(failed, { current: true }),
    record('2026-10-09T11:30:00.000Z', { source: 'restore', current: false, stable: true }),
    record('2026-10-09T11:00:00.000Z', { verifiedAt: 'x', current: false, stable: false, rolledBackAt: 'y' }),
    record('2026-10-09T10:30:00.000Z', { verifiedAt: 'x', current: false, stable: false }),
    record('2026-10-09T10:00:00.000Z', { verifiedAt: 'x', current: false, stable: true }),
  ];
  assert.equal(latestStable(records, failed)?.deployedAt, '2026-10-09T10:00:00.000Z');
});

test('a verified rollback or restore is as good as the deployment it restored', () => {
  const records = [
    record(failed, { current: true }),
    record('2026-10-09T11:00:00.000Z', { source: 'rollback', verifiedAt: 'x', current: false, stable: true }),
  ];
  assert.equal(latestStable(records, failed)?.source, 'rollback');
});

test('never picks the failed deployment, a later one or the current one', () => {
  const records = [
    record('2026-10-09T13:00:00.000Z', { verifiedAt: 'x', current: false, stable: true }),
    record(failed, { verifiedAt: 'x', current: true }),
  ];
  assert.equal(latestStable(records, failed), undefined);
  assert.equal(latestStable([record('2026-10-09T11:00:00.000Z', { verifiedAt: 'x', current: true })], failed), undefined);
});

test('counts verified records from before `stable` existed once they were retired', () => {
  const legacy = record('2026-10-09T09:00:00.000Z', { verifiedAt: 'x', current: false });
  assert.equal(latestStable([record(failed), legacy], failed), legacy);
});
