import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { APIGatewayClient, GetRestApisCommand, GetStagesCommand } from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client, GetApisCommand, GetStagesCommand as GetV2StagesCommand,
} from '@aws-sdk/client-apigatewayv2';
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
