import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as messages } from '../lambda/api/messages.js';
import { handler as orders } from '../lambda/api/orders.js';
import { handler as users } from '../lambda/api/users.js';

const event = (httpMethod: string, resource: string, body?: object) => ({
  httpMethod, resource, body: body && JSON.stringify(body),
  requestContext: { requestId: 'req-1', stage: 'v1', authorizer: { claims: { email: 'someone@example.com' } } },
}) as unknown as APIGatewayProxyEvent;

test('each backend serves its own resource only', async () => {
  const listUsers = await users(event('GET', '/users'));
  assert.equal(listUsers.statusCode, 200);
  assert.deepEqual(JSON.parse(listUsers.body).users, []);
  const listMessages = await messages(event('GET', '/messages'));
  assert.deepEqual(JSON.parse(listMessages.body).messages, []);
  const listOrders = await orders(event('GET', '/orders'));
  assert.deepEqual(JSON.parse(listOrders.body).orders, []);

  const posted = await messages(event('POST', '/messages', { message: 'hi' }));
  assert.equal(posted.statusCode, 201);
  assert.deepEqual(JSON.parse(posted.body), { message: 'Received on /messages', echo: 'hi', from: 'someone@example.com' });

  // a route of the other resource is not theirs
  assert.equal((await users(event('GET', '/messages'))).statusCode, 404);
  assert.equal((await messages(event('POST', '/users', { message: 'hi' }))).statusCode, 404);
  assert.equal((await orders(event('GET', '/users'))).statusCode, 404);
  assert.equal(listUsers.headers?.['Access-Control-Allow-Origin'], '*');
});

test('chaos mode fails requests with a 500', async () => {
  process.env.CHAOS_FAILURE_RATE = '1';
  // the rate is read when the module loads: load a fresh copy
  const { resourceHandler } = await import(`../lambda/api/http.js?chaos=${Date.now()}`);
  assert.equal((await resourceHandler('users')(event('GET', '/users'))).statusCode, 500);
  delete process.env.CHAOS_FAILURE_RATE;
});

test('logs one line per request and one per response, without caller details', async (t) => {
  const lines: any[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(JSON.parse(line)));
  await orders(event('POST', '/orders', { message: 'hi' }));
  assert.deepEqual(lines[0], { msg: 'request', route: 'POST /orders', requestId: 'req-1', stage: 'v1' });
  assert.equal(lines[1].msg, 'response');
  assert.equal(lines[1].status, 201);
  assert.equal(typeof lines[1].durationMs, 'number');
  assert.ok(!JSON.stringify(lines).includes('someone@example.com'));
});
