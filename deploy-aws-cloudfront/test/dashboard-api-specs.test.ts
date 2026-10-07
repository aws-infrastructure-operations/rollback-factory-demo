import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getRecordedSpec, routesOf } from '../lambda/dashboard-api/api-gateway-specs.js';
import { handler } from '../lambda/dashboard-api/handler.js';

const PROJECT = 'rollback-factory-demo';
const API = { id: 'r1xyz98uvw', name: 'api-user-dev' };
const AT = '2026-10-06T09:00:00.000Z';

const SPEC = {
  openapi: '3.0.1',
  info: { title: 'api-user-dev', version: '2026-10-06T09:00:00Z' },
  paths: {
    '/users': {
      get: { 'x-amazon-apigateway-integration': { uri: 'arn:aws:apigateway:...:function:handler:${stageVariables.lambdaAlias}/invocations' } },
      post: {},
      options: {},
    },
    '/messages/{id}': { 'x-amazon-apigateway-any-method': {}, parameters: [] },
  },
  components: { securitySchemes: { cognito: { 'x-amazon-apigateway-authorizer': { providerARNs: ['arn:aws:cognito-idp:...'] } } } },
};

const fakeDynamo = (records: object[]) => ({
  send: async (command: any) => {
    if (!(command instanceof QueryCommand)) throw new Error(`unexpected ${command.constructor.name}`);
    const at = command.input.ExpressionAttributeValues?.[':at'];
    return { Items: records.filter((r: any) => !at || r.deployedAt === at) };
  },
}) as unknown as DynamoDBDocumentClient;

const record = (extra: object = {}) => ({
  apiName: API.name, deployedAt: AT, restApiId: API.id, stageName: 'v1', deploymentId: 'dep09',
  specBucket: 'rollback-factory-demo-860193728768-deployments-dev', specKey: 'api-user-dev/20261006T090000Z/openapi.json',
  source: 'cicd', ...extra,
});

const fakeS3 = (body: string | undefined, length = body?.length) => {
  const sent: any[] = [];
  const client = {
    send: async (command: any) => {
      sent.push(command);
      if (!(command instanceof GetObjectCommand)) throw new Error(`unexpected ${command.constructor.name}`);
      if (body === undefined) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      return { ContentLength: length, Body: { transformToString: async () => body } };
    },
  };
  return { client: client as unknown as S3Client, sent };
};

test('lists the routes of an OpenAPI document, ANY for the any-method extension', () => {
  assert.deepEqual(routesOf(SPEC), ['ANY /messages/{id}', 'GET /users', 'OPTIONS /users', 'POST /users']);
  assert.deepEqual(routesOf({}), []);
});

test('summarizes a recorded deployment\'s export from S3, without its integration details', async () => {
  const s3 = fakeS3(JSON.stringify(SPEC));
  const outcome = await getRecordedSpec(fakeDynamo([record()]), s3.client, PROJECT, API, AT);
  assert.deepEqual(outcome, {
    ok: true,
    spec: { deployedAt: AT, title: 'api-user-dev', version: '2026-10-06T09:00:00Z', routes: ['ANY /messages/{id}', 'GET /users', 'OPTIONS /users', 'POST /users'] },
  });
  assert.deepEqual(s3.sent[0].input, { Bucket: record().specBucket, Key: record().specKey });
  assert.doesNotMatch(JSON.stringify(outcome), /arn:|cognito|integration/);
});

test('answers 404 for no record, a record of another API, or a missing export, and 502 for a huge one', async () => {
  const get = (records: object[], s3 = fakeS3(JSON.stringify(SPEC))) => getRecordedSpec(fakeDynamo(records), s3.client, PROJECT, API, AT);
  assert.equal(((await get([])) as { status: number }).status, 404);
  assert.equal(((await get([record({ restApiId: 'old0000000' })])) as { status: number }).status, 404);
  assert.equal(((await get([record()], fakeS3(undefined))) as { status: number }).status, 404);
  assert.equal(((await get([record()], fakeS3('{}', 5 * 1024 * 1024))) as { status: number }).status, 502);
  // another API than api-user-<env> has no records at all
  const other = await getRecordedSpec(fakeDynamo([record()]), fakeS3('{}').client, PROJECT, { id: API.id, name: 'auth-api' }, AT);
  assert.equal((other as { status: number }).status, 404);
});

test('checks the id and deployedAt before calling AWS', async () => {
  const get = (path: string, query = '') => handler({ rawPath: path, rawQueryString: query, requestContext: { http: { method: 'GET' } } });
  assert.equal((await get(`/api/api-gateways/${API.id}/spec`)).statusCode, 400);
  assert.equal((await get(`/api/api-gateways/${API.id}/spec`, 'deployedAt=yesterday')).statusCode, 400);
  assert.equal((await get('/api/api-gateways/NOT-AN-ID/spec', `deployedAt=${AT}`)).statusCode, 400);
  assert.equal((await handler({ rawPath: `/api/api-gateways/${API.id}/spec`, requestContext: { http: { method: 'POST' } } })).statusCode, 405);
});
