import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  APIGatewayClient, GetDeploymentsCommand, GetRestApiCommand, GetRestApisCommand, GetStagesCommand,
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client, GetApiCommand, GetApisCommand, GetDeploymentsCommand as GetV2DeploymentsCommand,
  GetStagesCommand as GetV2StagesCommand,
} from '@aws-sdk/client-apigatewayv2';
import { getApiGatewayDetails } from '../lambda/dashboard-api/api-gateway-details.js';
import { listApiGateways } from '../lambda/dashboard-api/api-gateways.js';
import { handler } from '../lambda/dashboard-api/handler.js';

const date = (iso: string) => new Date(iso);

/** v1 client: two pages of REST APIs, stages per API. */
const fakeRest = () => {
  const sent: any[] = [];
  const client = {
    send: async (command: any) => {
      sent.push(command);
      if (command instanceof GetRestApisCommand) {
        return command.input.position
          ? { items: [{ id: 'r2', name: 'empty-api' }] }
          : { items: [{ id: 'r1', name: 'api-user-dev' }], position: 'page-2' };
      }
      if (command instanceof GetStagesCommand) {
        return command.input.restApiId === 'r1'
          ? { item: [
            { stageName: 'live', lastUpdatedDate: date('2026-10-05T10:00:00Z') },
            { stageName: 'integration', createdDate: date('2026-10-06T09:00:00Z') },
          ] }
          : { item: [] };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
  return { client: client as unknown as APIGatewayClient, sent };
};

/** v2 client: one HTTP and one WebSocket API, the HTTP API's stages over two pages. */
const fakeV2 = () => {
  const client = {
    send: async (command: any) => {
      if (command instanceof GetApisCommand) {
        return { Items: [
          { ApiId: 'h1', Name: 'auth-api', ProtocolType: 'HTTP' },
          { ApiId: 'w1', Name: 'chat', ProtocolType: 'WEBSOCKET' },
        ] };
      }
      if (command instanceof GetV2StagesCommand) {
        if (command.input.ApiId === 'w1') return { Items: [{ StageName: 'prod', CreatedDate: date('2026-09-01T00:00:00Z') }] };
        return command.input.NextToken
          ? { Items: [{ StageName: '$default', LastUpdatedDate: date('2026-10-06T12:00:00Z') }] }
          : { Items: [{ StageName: 'dev', LastUpdatedDate: date('2026-10-01T00:00:00Z') }], NextToken: 'more' };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
  return client as unknown as ApiGatewayV2Client;
};

test('lists REST, HTTP and WebSocket APIs with their stages, latest deployment first', async () => {
  const { client } = fakeRest();
  assert.deepEqual(await listApiGateways(client, fakeV2()), [
    { id: 'h1', name: 'auth-api', type: 'HTTP', stages: ['$default', 'dev'], lastDeployed: '2026-10-06T12:00:00.000Z' },
    { id: 'r1', name: 'api-user-dev', type: 'REST', stages: ['integration', 'live'], lastDeployed: '2026-10-06T09:00:00.000Z' },
    { id: 'w1', name: 'chat', type: 'WEBSOCKET', stages: ['prod'], lastDeployed: '2026-09-01T00:00:00.000Z' },
    // no stages: no deployment date, listed last
    { id: 'r2', name: 'empty-api', type: 'REST', stages: [] },
  ]);
});

test('follows the REST API pages', async () => {
  const { client, sent } = fakeRest();
  await listApiGateways(client, fakeV2());
  const pages = sent.filter((c) => c instanceof GetRestApisCommand).map((c) => c.input.position);
  assert.deepEqual(pages, [undefined, 'page-2']);
});

const request = (rawPath: string, method = 'GET') => ({ rawPath, requestContext: { http: { method } } });

test('answers only GET /api/api-gateways', async () => {
  assert.equal((await handler(request('/api/other'))).statusCode, 404);
  assert.equal((await handler(request('/api/api-gateways', 'POST'))).statusCode, 405);
});

// --- One API's details ------------------------------------------------------------------------

const restDetailsClient = (overrides: { notFound?: boolean } = {}) => ({
  send: async (command: any) => {
    if (overrides.notFound) throw Object.assign(new Error('Invalid API identifier'), { name: 'NotFoundException' });
    if (command instanceof GetRestApiCommand) {
      return { name: 'api-user-dev', endpointConfiguration: { types: ['REGIONAL'] }, createdDate: date('2026-09-01T00:00:00Z') };
    }
    if (command instanceof GetStagesCommand) {
      return { item: [
        { stageName: 'live', deploymentId: 'dep1', lastUpdatedDate: date('2026-10-05T10:00:00Z') },
        { stageName: 'integration', deploymentId: 'dep2', lastUpdatedDate: date('2026-10-06T09:00:00Z') },
      ] };
    }
    if (command instanceof GetDeploymentsCommand) {
      return { items: [
        { id: 'dep0', description: 'first', createdDate: date('2026-10-01T00:00:00Z') },
        { id: 'dep2', description: 'next', createdDate: date('2026-10-06T09:00:00Z') },
        { id: 'dep1', description: 'current', createdDate: date('2026-10-05T10:00:00Z') },
      ] };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  },
}) as unknown as APIGatewayClient;

const v2DetailsClient = () => ({
  send: async (command: any) => {
    if (command instanceof GetApiCommand) {
      return { Name: 'auth-api', ProtocolType: 'HTTP', ApiEndpoint: 'https://h1abc23def.execute-api.eu-central-1.amazonaws.com' };
    }
    if (command instanceof GetV2StagesCommand) return { Items: [{ StageName: '$default', DeploymentId: 'd9', LastUpdatedDate: date('2026-10-06T12:00:00Z') }] };
    if (command instanceof GetV2DeploymentsCommand) {
      return { Items: [{ DeploymentId: 'd9', Description: 'auto', CreatedDate: date('2026-10-06T12:00:00Z'), DeploymentStatus: 'DEPLOYED' }] };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  },
}) as unknown as ApiGatewayV2Client;

test('details of a REST API: stages, deployments newest first with the stages serving them, configuration', async () => {
  const details = await getApiGatewayDetails(restDetailsClient(), fakeV2(), 'r1xyz98uvw', 'REST', 'eu-central-1');
  assert.deepEqual(details!.stages.map((s) => [s.name, s.deploymentId, s.deployedAt]), [
    ['integration', 'dep2', '2026-10-06T09:00:00.000Z'],
    ['live', 'dep1', '2026-10-05T10:00:00.000Z'],
  ]);
  assert.deepEqual(details!.deployments.map((d) => [d.id, d.stages]), [['dep2', ['integration']], ['dep1', ['live']], ['dep0', []]]);
  const config = Object.fromEntries(details!.configuration.map((c) => [c.label, c.value]));
  assert.equal(config['Endpoint type'], 'REGIONAL');
  assert.equal(config['Invoke URL'], 'https://r1xyz98uvw.execute-api.eu-central-1.amazonaws.com/<stage>');
  assert.equal(config.Description, undefined, 'empty settings are left out');
});

test('details of an HTTP API', async () => {
  const details = await getApiGatewayDetails(fakeRest().client, v2DetailsClient(), 'h1abc23def', 'HTTP', 'eu-central-1');
  assert.equal(details!.type, 'HTTP');
  assert.deepEqual(details!.deployments, [
    { id: 'd9', description: 'auto', createdAt: '2026-10-06T12:00:00.000Z', status: 'DEPLOYED', stages: ['$default'] },
  ]);
});

test('details of an API that does not exist are undefined', async () => {
  assert.equal(await getApiGatewayDetails(restDetailsClient({ notFound: true }), fakeV2(), 'zzzzzzzzzz', 'REST', 'eu-central-1'), undefined);
});

test('rejects malformed ids and types before calling AWS', async () => {
  const query = (rawPath: string, rawQueryString: string) => ({ rawPath, rawQueryString, requestContext: { http: { method: 'GET' } } });
  assert.equal((await handler(query('/api/api-gateways/abc', 'type=REST'))).statusCode, 400);
  assert.equal((await handler(query('/api/api-gateways/r1xyz98uvw', 'type=SOAP'))).statusCode, 400);
  assert.equal((await handler(query('/api/api-gateways/r1xyz98uvw/stages', 'type=REST'))).statusCode, 404);
});
