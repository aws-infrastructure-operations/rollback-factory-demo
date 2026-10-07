import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  deploymentsTableFor, isDeployedAt, listRecordedDeployments, restoreRecordedDeployment, rollbackServiceFor,
} from '../lambda/dashboard-api/api-gateway-deployments.js';
import { handler } from '../lambda/dashboard-api/handler.js';

const PROJECT = 'rollback-factory-demo';
const API = { id: 'r1xyz98uvw', name: 'api-user-dev' };

const record = (deployedAt: string, extra: Record<string, unknown> = {}) => ({
  apiName: 'api-user-dev', deployedAt, restApiId: API.id, stageName: 'v1', deploymentId: `dep-${deployedAt.slice(11, 13)}`,
  specBucket: 'rollback-factory-demo-860193728768-deployments-dev', specKey: `api-user-dev/${deployedAt}/openapi.json`,
  source: 'cicd', actor: 'github:someone', ...extra,
});

const records = [
  record('2026-10-07T12:00:00.000Z', { current: true, verifiedAt: '2026-10-07T12:05:00.000Z', commitSha: '74f6e80aaaa', lambdaVersion: '7' }),
  record('2026-10-07T10:00:00.000Z', { stable: false, rolledBackAt: '2026-10-07T10:20:00.000Z' }),
  record('2026-10-06T09:00:00.000Z', { stable: true, stableForHumanReadable: '1 day', verifiedAt: '2026-10-06T09:05:00.000Z' }),
  // an earlier API of the same name
  record('2026-10-01T09:00:00.000Z', { restApiId: 'old0000000' }),
];

const fakeDynamo = (opts: { missingTable?: boolean } = {}) => {
  const sent: any[] = [];
  const client = {
    send: async (command: any) => {
      sent.push(command);
      if (!(command instanceof QueryCommand)) throw new Error(`unexpected ${command.constructor.name}`);
      if (opts.missingTable) throw Object.assign(new Error('Requested resource not found'), { name: 'ResourceNotFoundException' });
      const at = command.input.ExpressionAttributeValues?.[':at'];
      return { Items: at ? records.filter((r) => r.deployedAt === at) : records };
    },
  };
  return { client: client as unknown as DynamoDBDocumentClient, sent };
};

const fakeLambda = (answer: { FunctionError?: string; Payload?: string } = { Payload: '{"action":"restored"}' }) => {
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

test('only api-user-<env> has a deployments table and a rollback service', () => {
  assert.equal(deploymentsTableFor('api-user-dev', PROJECT), 'rollback-factory-demo-deployments-dev');
  assert.equal(rollbackServiceFor('api-user-prod', PROJECT), 'rollback-factory-demo-rollback-service-prod');
  for (const name of ['auth-api', 'api-user', 'api-user-dev-copy', 'my-api-user-dev']) {
    assert.equal(deploymentsTableFor(name, PROJECT), undefined, name);
    assert.equal(rollbackServiceFor(name, PROJECT), undefined, name);
  }
});

test('accepts only ISO 8601 deployedAt values', () => {
  assert.ok(isDeployedAt('2026-10-07T12:00:00.000Z'));
  assert.ok(isDeployedAt('2026-10-07T12:00:00Z'));
  for (const value of ['2026-10-07', 'yesterday', 42, undefined, '2026-10-07T12:00:00.000Z OR 1=1']) assert.ok(!isDeployedAt(value), String(value));
});

test('lists the recorded deployments of this API id, newest first, with their status and spec', async () => {
  const { client, sent } = fakeDynamo();
  const recorded = await listRecordedDeployments(client, PROJECT, API.name, API.id);
  assert.equal(sent[0].input.TableName, 'rollback-factory-demo-deployments-dev');
  assert.equal(sent[0].input.ScanIndexForward, false);
  assert.deepEqual(recorded!.map((d) => d.deployedAt), ['2026-10-07T12:00:00.000Z', '2026-10-07T10:00:00.000Z', '2026-10-06T09:00:00.000Z']);
  assert.deepEqual(recorded![0], {
    deployedAt: '2026-10-07T12:00:00.000Z', deploymentId: 'dep-12', stageName: 'v1', lambdaVersion: '7',
    spec: 's3://rollback-factory-demo-860193728768-deployments-dev/api-user-dev/2026-10-07T12:00:00.000Z/openapi.json',
    source: 'cicd', actor: 'github:someone', commit: '74f6e80aaaa', current: true, verified: true, rolledBack: false,
  });
  assert.deepEqual([recorded![1].rolledBack, recorded![1].verified], [true, false]);
  assert.equal(recorded![2].stableFor, '1 day');
});

test('APIs this project does not deploy, or whose environment has no table, have no recorded deployments', async () => {
  const other = fakeDynamo();
  assert.equal(await listRecordedDeployments(other.client, PROJECT, 'auth-api', API.id), undefined);
  assert.equal(other.sent.length, 0);
  assert.equal(await listRecordedDeployments(fakeDynamo({ missingTable: true }).client, PROJECT, API.name, API.id), undefined);
});

test('restores a recorded deployment through the environment\'s rollback service', async () => {
  const lambda = fakeLambda();
  const outcome = await restoreRecordedDeployment(fakeDynamo().client, lambda.client, PROJECT, API, {
    deployedAt: '2026-10-06T09:00:00.000Z', reason: 'bad config',
  });
  assert.deepEqual(outcome, { ok: true, result: { action: 'restored' } });
  assert.equal(lambda.sent[0].input.FunctionName, 'rollback-factory-demo-rollback-service-dev');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(lambda.sent[0].input.Payload)), {
    type: 'restore', manager: 'apigateway', deployedAt: '2026-10-06T09:00:00.000Z', actor: 'dashboard', reason: 'bad config',
  });
});

test('refuses restores the rollback service should not get', async () => {
  const restore = async (api: typeof API, deployedAt: string) => {
    const lambda = fakeLambda();
    const outcome = await restoreRecordedDeployment(fakeDynamo().client, lambda.client, PROJECT, api, { deployedAt });
    assert.equal(lambda.sent.length, 0, 'never invoked');
    return outcome.ok ? 200 : outcome.status;
  };
  assert.equal(await restore({ id: API.id, name: 'auth-api' }, '2026-10-06T09:00:00.000Z'), 400, 'not deployed by this project');
  assert.equal(await restore(API, '2026-10-05T00:00:00.000Z'), 404, 'not recorded');
  assert.equal(await restore(API, '2026-10-01T09:00:00.000Z'), 404, 'recorded for another API id');
  assert.equal(await restore(API, '2026-10-07T12:00:00.000Z'), 409, 'already current');
});

test('reports a failed restore without its details', async () => {
  const lambda = fakeLambda({ FunctionError: 'Unhandled', Payload: '{"errorMessage":"PutRestApi failed: internal detail"}' });
  const outcome = await restoreRecordedDeployment(fakeDynamo().client, lambda.client, PROJECT, API, { deployedAt: '2026-10-06T09:00:00.000Z' });
  assert.deepEqual(outcome, { ok: false, status: 502, message: 'The rollback service could not restore api-user-dev' });
});

const request = (rawPath: string, method: string, body?: string) => ({ rawPath, body, requestContext: { http: { method } } });

test('restores only with POST /api/api-gateways/<id>/restore and a valid body, checked before calling AWS', async () => {
  assert.equal((await handler(request(`/api/api-gateways/${API.id}/restore`, 'GET'))).statusCode, 405);
  assert.equal((await handler(request(`/api/api-gateways/${API.id}`, 'POST', '{}'))).statusCode, 405);
  assert.equal((await handler(request('/api/lambda-functions/fn/restore', 'GET'))).statusCode, 404);
  assert.equal((await handler(request('/api/cloudfront-distributions/E1LIVE0000000/restore', 'GET'))).statusCode, 405);
  for (const body of [undefined, 'not json', '{}', '{"deployedAt":"yesterday"}', `{"deployedAt":"2026-10-06T09:00:00.000Z","reason":${JSON.stringify('x'.repeat(201))}}`]) {
    assert.equal((await handler(request(`/api/api-gateways/${API.id}/restore`, 'POST', body))).statusCode, 400, String(body));
  }
  assert.equal((await handler(request('/api/api-gateways/NOT-AN-ID/restore', 'POST', '{"deployedAt":"2026-10-06T09:00:00.000Z"}'))).statusCode, 400);
});
