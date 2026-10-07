import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { listArchivedVersions } from '../lambda/dashboard-api/lambda-archive.js';

const TABLE = 'rollback-factory-demo-lambda-archive-dev';
const FN = 'service-lambda-dev';
const BUCKET = 'rollback-factory-demo-860193728768-lambda-archive-dev';

const item = (version: number, extra: Record<string, unknown> = {}) => ({
  functionName: FN, sk: `VERSION#${String(version).padStart(10, '0')}`, version,
  s3Bucket: BUCKET, s3Key: `${FN}/${FN}-${version}.zip`, codeSha256: `sha-${version}`, ...extra,
});

const fakeDynamo = (pages: unknown[][], opts: { missingTable?: boolean } = {}) => {
  const sent: QueryCommand[] = [];
  const client = {
    send: async (command: any) => {
      if (!(command instanceof QueryCommand)) throw new Error(`unexpected ${command.constructor.name}`);
      sent.push(command);
      if (opts.missingTable) throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
      const page = sent.length - 1;
      return { Items: pages[page], ...(page + 1 < pages.length && { LastEvaluatedKey: { page } }) };
    },
  };
  return { client: client as unknown as DynamoDBDocumentClient, sent };
};

test('reads the archived versions with their stable marks, over every page', async () => {
  const { client, sent } = fakeDynamo([
    [item(1, { stable: true, stableAt: '2026-10-06T10:00:00.000Z', liveAt: '2026-10-06T09:00:00.000Z' })],
    [item(2, { stable: false, rolledBackAt: '2026-10-07T10:00:00.000Z', liveAt: '2026-10-07T09:50:00.000Z' }), item(3)],
  ]);
  const archive = await listArchivedVersions(client, TABLE, FN);

  assert.deepEqual([...archive.keys()], ['1', '2', '3']);
  assert.deepEqual(archive.get('1'), {
    s3Uri: `s3://${BUCKET}/${FN}/${FN}-1.zip`, stable: true,
    stableAt: '2026-10-06T10:00:00.000Z', liveAt: '2026-10-06T09:00:00.000Z',
  });
  assert.equal(archive.get('2')!.stable, false);
  assert.equal(archive.get('2')!.rolledBackAt, '2026-10-07T10:00:00.000Z');
  assert.equal(archive.get('3')!.stable, false, 'never marked stable');
  // the function's version items only, not CURRENT
  assert.equal(sent[0].input.TableName, TABLE);
  assert.deepEqual(sent[0].input.ExpressionAttributeValues, { ':fn': FN, ':prefix': 'VERSION#' });
  assert.equal(sent.length, 2);
});

test('an environment without the rollback service has no archive', async () => {
  const { client } = fakeDynamo([], { missingTable: true });
  assert.equal((await listArchivedVersions(client, TABLE, FN)).size, 0);
});
