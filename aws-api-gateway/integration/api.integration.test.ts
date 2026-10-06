/**
 * Integration tests against the deployed API of API_ENV (default dev).
 *
 * Needs AWS credentials that can read the stack and administer its user pool.
 * A throw-away Cognito user is created for the run and deleted afterwards,
 * unless API_USERNAME / API_PASSWORD point at an existing user.
 *
 * Keep the number of intentional 4xx calls small: they count towards the
 * API's 4XXError alarm.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { getConfig } from '../lib/config.js';
import { deleteUser, ensureUser, getIdToken, randomPassword } from '../scripts/lib/cognito.js';
import { requireStackOutputs, StackOutputs } from '../scripts/lib/stack.js';

const config = getConfig(process.env.API_ENV ?? 'dev');

let outputs: StackOutputs;
let token: string;
let cleanup: (() => Promise<void>) | undefined;

const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
  const res = await fetch(`${outputs.ApiUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      ...(opts.token && { Authorization: opts.token }),
      ...(opts.body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

before(async () => {
  outputs = await requireStackOutputs(config);

  let username = process.env.API_USERNAME;
  let password = process.env.API_PASSWORD;
  if (!username || !password) {
    username = `integration-${randomUUID()}@example.com`;
    password = randomPassword();
    await ensureUser(outputs.UserPoolId, username, password);
    cleanup = () => deleteUser(outputs.UserPoolId, username!);
  }
  token = await getIdToken(outputs.UserPoolClientId, username, password);
  await waitUntilReady();
});

/**
 * A fresh deployment (and its Lambda invoke permissions) can take a few seconds
 * to serve everywhere, answering 5xx / 403 meanwhile. Wait up to READY_TIMEOUT_MS
 * for a normal answer; if it never comes the tests run anyway and report the failure.
 */
const READY_TIMEOUT_MS = 60_000;
async function waitUntilReady() {
  const until = Date.now() + READY_TIMEOUT_MS;
  let last = 0;
  while (Date.now() < until) {
    last = (await call('GET', '/users', { token })).status;
    if (last < 500 && last !== 403) return;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  console.warn(`API not ready after ${READY_TIMEOUT_MS / 1000}s (last GET /users: ${last}) - running tests anyway`);
}

after(async () => {
  await cleanup?.();
});

describe(`${config.apiName} (stage ${config.stageName})`, () => {
  for (const resource of ['users', 'messages']) {
    test(`GET /${resource} returns 200`, async () => {
      const res = await call('GET', `/${resource}`, { token });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(typeof res.body.message, 'string');
      assert.ok(Array.isArray(res.body[resource]), `expected "${resource}" array`);
    });

    test(`POST /${resource} echoes the message with 201`, async () => {
      const message = `integration ${randomUUID()}`;
      const res = await call('POST', `/${resource}`, { token, body: { message } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.echo, message);
      assert.match(res.body.from, /@/);
    });
  }

  test('answers CORS preflights and adds CORS headers (browser frontend)', async () => {
    const base = outputs.ApiUrl.replace(/\/$/, '');
    const preflight = await fetch(`${base}/messages`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.cloudfront.net',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.ok(preflight.status < 300, `preflight status ${preflight.status}`);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Authorization/i);

    const get = await fetch(`${base}/users`, { headers: { Authorization: token } });
    assert.equal(get.headers.get('access-control-allow-origin'), '*');
    const unauthorized = await fetch(`${base}/users`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('access-control-allow-origin'), '*');
  });

  test('rejects requests without a token (401)', async () => {
    const res = await call('GET', '/users');
    assert.equal(res.status, 401);
  });

  test('rejects an invalid token (401)', async () => {
    const res = await call('GET', '/messages', { token: 'not-a-jwt' });
    assert.equal(res.status, 401);
  });

  test('rejects a POST body without "message" (400)', async () => {
    const res = await call('POST', '/messages', { token, body: { text: 'wrong field' } });
    assert.equal(res.status, 400);
  });
});
