import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config.js';
import { ApiUserStack } from '../lib/api-user-stack.js';
import {
  extractRoutes, GENERATED_MARKER, parseEnvironment, renderEnvironment, renderRequest, requestFile,
} from '../scripts/lib/collection.js';

const template = () => {
  const app = new cdk.App();
  const stack = new ApiUserStack(app, 'Test', { config: getConfig('dev') });
  return Template.fromStack(stack).toJSON() as any;
};

test('extracts every API method from the synthesized stack', () => {
  const routes = extractRoutes(template());
  assert.deepEqual(
    routes.map((r) => `${r.method} ${r.path}`),
    ['GET /messages', 'POST /messages', 'GET /orders', 'POST /orders', 'GET /users', 'POST /users'],
  );
  assert.deepEqual(routes.find((r) => r.method === 'POST')?.sampleBody, {
    message: 'hello from bruno (message)',
  });
  assert.equal(routes.find((r) => r.method === 'GET')?.sampleBody, undefined);
});

test('renders a Bruno request per route', () => {
  const route = { method: 'POST', path: '/users', sampleBody: { message: 'hi' } };
  assert.deepEqual(requestFile(route), { folder: 'users', file: 'post-users.bru' });

  const bru = renderRequest(route, 2);
  assert.match(bru, /^post \{\n  url: \{\{baseUrl\}\}\/users\n  body: json\n  auth: inherit\n\}/m);
  assert.match(bru, /body:json \{\n  \{\n    "message": "hi"\n  \}\n\}/);
  assert.match(bru, /seq: 2/);
  assert.ok(bru.includes(GENERATED_MARKER));
});

test('environment files round-trip', () => {
  const vars = { baseUrl: 'https://x.execute-api.eu-west-1.amazonaws.com/v1', idToken: '{{process.env.ID_TOKEN_DEV}}' };
  assert.deepEqual(parseEnvironment(renderEnvironment(vars)), vars);
});
