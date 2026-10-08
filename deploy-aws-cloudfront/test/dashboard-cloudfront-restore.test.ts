import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { restoreRelease, rollbackServiceForDistribution } from '../lambda/dashboard-api/cloudfront-distributions.js';
import { route as handler } from '../lambda/dashboard-api/handler.js';

const PROJECT = 'rollback-factory-demo';
const LIVE = '20261007T101500Z';
const GOOD = '20261006T190000Z';

const distribution = (comment: string) => ({
  Distribution: {
    Id: 'E1LIVE0000000', DomainName: 'd111.cloudfront.net', Status: 'Deployed',
    DistributionConfig: {
      Comment: comment, Enabled: true,
      Origins: { Quantity: 2, Items: [
        { Id: 'api', DomainName: 'abc123.lambda-url.eu-central-1.on.aws', OriginPath: '' },
        { Id: 'site', DomainName: 'site.s3.eu-central-1.amazonaws.com', OriginPath: `/releases/${LIVE}` },
      ] },
    },
  },
});

const fakeCloudFront = (comment = 'frontend-user-dev') => ({
  send: async (command: any) => {
    if (!(command instanceof GetDistributionCommand)) throw new Error(`unexpected ${command.constructor.name}`);
    if (command.input.Id !== 'E1LIVE0000000') throw Object.assign(new Error('no'), { name: 'NoSuchDistribution' });
    return distribution(comment);
  },
}) as unknown as CloudFrontClient;

const records = [
  { frontendName: 'frontend-user-dev', deployedAt: '2026-10-07T10:20:00.000Z', releaseId: LIVE, distributionId: 'E1LIVE0000000', source: 'cicd', current: true },
  { frontendName: 'frontend-user-dev', deployedAt: '2026-10-06T19:05:00.000Z', releaseId: GOOD, distributionId: 'E1LIVE0000000', source: 'cicd', verifiedAt: '2026-10-06T19:10:00.000Z' },
  // the live release again, from an earlier activation
  { frontendName: 'frontend-user-dev', deployedAt: '2026-10-05T08:00:00.000Z', releaseId: LIVE, distributionId: 'E1LIVE0000000', source: 'cicd' },
  // a recreated distribution under the same name
  { frontendName: 'frontend-user-dev', deployedAt: '2026-09-01T00:00:00.000Z', releaseId: '20260901T000000Z', distributionId: 'EOLD000000000', source: 'cicd' },
];

const fakeDynamo = () => ({
  send: async (command: any) => {
    if (!(command instanceof QueryCommand)) throw new Error(`unexpected ${command.constructor.name}`);
    return { Items: records };
  },
}) as unknown as DynamoDBDocumentClient;

const fakeLambda = (answer: { FunctionError?: string; Payload?: string } = { Payload: '{"action":"restored","to":"20261006T190000Z"}' }) => {
  const sent: any[] = [];
  const client = {
    send: async (command: any) => {
      sent.push(command);
      if (!(command instanceof InvokeCommand)) throw new Error(`unexpected ${command.constructor.name}`);
      return { ...answer, Payload: answer.Payload && new TextEncoder().encode(answer.Payload) };
    },
  };
  return { client: client as unknown as LambdaClient, sent };
};

const invoked = (sent: any[]) => ({
  functionName: sent[0].input.FunctionName,
  payload: JSON.parse(new TextDecoder().decode(sent[0].input.Payload)),
});

test('only frontend-user-<env> distributions have a rollback service', () => {
  assert.equal(rollbackServiceForDistribution('frontend-user-prod', PROJECT), 'rollback-factory-demo-rollback-service-prod');
  for (const comment of ['frontend-user-dev-integration', 'frontend-user', '', undefined]) {
    assert.equal(rollbackServiceForDistribution(comment, PROJECT), undefined, String(comment));
  }
});

test('asks the environment\'s rollback service to restore the recorded release, without waiting', async () => {
  const lambda = fakeLambda();
  const outcome = await restoreRelease(fakeCloudFront(), fakeDynamo(), lambda.client, PROJECT, 'E1LIVE0000000', {
    deployedAt: '2026-10-06T19:05:00.000Z', reason: 'bad banner',
  });
  assert.ok(outcome.ok);
  assert.match(outcome.operationId, /^dev\.cloudfront-restore\.\d{13}\.[0-9a-f]{8}$/);
  assert.equal(lambda.sent[0].input.InvocationType, 'Event');
  assert.deepEqual(invoked(lambda.sent), {
    functionName: 'rollback-factory-demo-rollback-service-dev',
    payload: {
      type: 'restore', manager: 'cloudfront', deployedAt: '2026-10-06T19:05:00.000Z', actor: 'dashboard', reason: 'bad banner',
      operationId: outcome.operationId,
    },
  });
});

test('refuses restores the rollback service should not get, without invoking it', async () => {
  const lambda = fakeLambda();
  const restore = (deployedAt: string, opts: { comment?: string; id?: string } = {}) =>
    restoreRelease(fakeCloudFront(opts.comment), fakeDynamo(), lambda.client, PROJECT, opts.id ?? 'E1LIVE0000000', { deployedAt });
  // the release live now, recorded now or earlier
  assert.equal(((await restore('2026-10-07T10:20:00.000Z')) as { status: number }).status, 409);
  assert.equal(((await restore('2026-10-05T08:00:00.000Z')) as { status: number }).status, 409);
  // not recorded, or recorded for another distribution of the same name
  assert.equal(((await restore('2026-01-01T00:00:00.000Z')) as { status: number }).status, 404);
  assert.equal(((await restore('2026-09-01T00:00:00.000Z')) as { status: number }).status, 404);
  // a distribution without history (integration), and one that doesn't exist
  assert.equal(((await restore('2026-10-06T19:05:00.000Z', { comment: 'frontend-user-dev-integration' })) as { status: number }).status, 400);
  assert.equal(((await restore('2026-10-06T19:05:00.000Z', { id: 'E9MISSING0000' })) as { status: number }).status, 404);
  assert.equal(lambda.sent.length, 0);
});

test('restores only with POST and a valid body, checked before calling AWS', async () => {
  const post = (path: string, body?: string) =>
    handler({ rawPath: path, body, requestContext: { http: { method: 'POST' } } });
  for (const body of [undefined, 'not json', '{}', '{"deployedAt":"yesterday"}']) {
    assert.equal((await post('/api/cloudfront-distributions/E1LIVE0000000/restore', body)).statusCode, 400, String(body));
  }
  assert.equal((await post('/api/cloudfront-distributions/e1-lower/restore', '{"deployedAt":"2026-10-06T19:05:00.000Z"}')).statusCode, 400);
  assert.equal((await post('/api/cloudfront-distributions/E1LIVE0000000', '{}')).statusCode, 405);
  assert.equal((await post('/api/lambda-functions/fn/restore', '{}')).statusCode, 405);
});
