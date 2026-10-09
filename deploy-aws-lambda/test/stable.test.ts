import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { latestStableVersion } from '../scripts/lib/stable.js';

const item = (version: number, extra: Record<string, AttributeValue> = {}): Record<string, AttributeValue> => ({
  functionName: { S: 'service-lambda-dev' },
  sk: { S: `VERSION#${String(version).padStart(10, '0')}` },
  version: { N: String(version) },
  codeSha256: { S: `sha-${version}` },
  s3Bucket: { S: 'archive' },
  s3Key: { S: `service-lambda-dev/service-lambda-dev-${version}.zip` },
  ...extra,
});
const stable = { stable: { BOOL: true }, liveAt: { S: 'x' } };

test('picks the newest stable version below the failed one', () => {
  const items = [item(3, stable), item(5, stable), item(4, { liveAt: { S: 'x' } }), item(6)];
  const target = latestStableVersion(items, 6);
  assert.equal(target?.version, 5);
  assert.equal(target?.s3Key, 'service-lambda-dev/service-lambda-dev-5.zip');
});

test('skips versions rolled back from, not marked stable or not below the failed one', () => {
  const items = [
    item(2, stable),
    item(3, { ...stable, stable: { BOOL: false }, rolledBackAt: { S: 'y' } }),
    item(4, { ...stable, rolledBackAt: { S: 'y' } }),
    item(5, { liveAt: { S: 'x' } }),
    item(7, stable),
  ];
  assert.equal(latestStableVersion(items, 6)?.version, 2);
});

test('nothing to roll back to without a stable version', () => {
  assert.equal(latestStableVersion([item(1, { liveAt: { S: 'x' } }), item(2)], 2), undefined);
});
