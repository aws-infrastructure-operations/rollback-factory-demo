import { strict as assert } from 'node:assert';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { AUTH_HEADER, authConfig, authenticate, cognitoVerifier } from '../lambda/dashboard-api/auth.js';
import { createHandler } from '../lambda/dashboard-api/handler.js';

const config = { region: 'eu-central-1', userPoolId: 'eu-central-1_TestPool1', clientId: 'testclientid1234567890abcd' };
const issuer = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;

// A pool signing key of our own: tokens are signed with it, and the verifier gets its public half
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] } as any;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(claims: Record<string, unknown> = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })}.${b64({
    sub: 'user-sub-1', email: 'jane@example.com', iss: issuer, aud: config.clientId,
    token_use: 'id', iat: now, auth_time: now, exp: now + 3600, ...claims,
  })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
}

const verify = cognitoVerifier(config, jwks);
const headers = (value: string) => ({ [AUTH_HEADER]: value });

test('accepts an ID token the pool issued to the dashboard client, and names its user', async () => {
  assert.deepEqual(await authenticate(headers(token()), verify), { sub: 'user-sub-1', email: 'jane@example.com' });
});

test('rejects missing, expired, forged and misdirected tokens', async () => {
  const now = Math.floor(Date.now() / 1000);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const rejected = {
    'no token': undefined,
    expired: token({ exp: now - 60, iat: now - 3660 }),
    'another key': token({}, other),
    'another client': token({ aud: 'someotherclient' }),
    'another pool': token({ iss: `https://cognito-idp.${config.region}.amazonaws.com/eu-central-1_Other` }),
    'an access token': token({ token_use: 'access' }),
    'not a JWT': 'Bearer nonsense',
  };
  for (const [what, value] of Object.entries(rejected)) {
    assert.equal(await authenticate(value === undefined ? {} : headers(value), verify), undefined, what);
  }
  // the signature covers the claims: changing one invalidates the token
  const [head, , sig] = token().split('.');
  assert.equal(await authenticate(headers(`${head}.${b64({ sub: 'admin', email: 'x@y.z', iss: issuer, aud: config.clientId, token_use: 'id', exp: now + 60 })}.${sig}`), verify), undefined);
});

test('the Authorization header is not read: CloudFront replaces it with its signature', async () => {
  assert.equal(await authenticate({ authorization: token() }, verify), undefined);
});

const env = { AWS_REGION: config.region, USER_POOL_ID: config.userPoolId, USER_POOL_CLIENT_ID: config.clientId };
const request = (rawPath: string, method = 'GET', extra: Record<string, string> = {}) =>
  ({ rawPath, headers: extra, requestContext: { http: { method } } });

test('GET /api/auth/config needs no sign-in and names the pool and client', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const handler = createHandler(() => { throw new Error('config must not verify anything'); });
    const res = await handler(request('/api/auth/config'));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), config);
    assert.equal((await handler(request('/api/auth/config', 'POST'))).statusCode, 405);
  } finally {
    process.env = saved;
  }
});

test('every other route answers 401 without a valid token, before touching any AWS API', async () => {
  const handler = createHandler(() => verify);
  for (const path of ['/api/api-gateways', '/api/lambda-functions', '/api/cloudfront-distributions/E123', '/api/rollbacks', '/api/operations/x', '/api/nope']) {
    const res = await handler(request(path));
    assert.equal(res.statusCode, 401, path);
    assert.deepEqual(JSON.parse(res.body), { message: 'Sign in required' });
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  const post = await handler(request('/api/api-gateways/abc123defg/restore', 'POST', headers(token({ exp: 1, iat: 0 }))));
  assert.equal(post.statusCode, 401);
});

test('a signed-in user reaches the routes', async () => {
  const handler = createHandler(() => verify);
  // an unknown route: past the sign-in, answered by the router
  assert.equal((await handler(request('/api/nope', 'GET', headers(token())))).statusCode, 404);
});

test('authConfig needs the pool, the client and the region', () => {
  assert.deepEqual(authConfig(env), config);
  assert.throws(() => authConfig({ AWS_REGION: 'eu-central-1' }), /USER_POOL_ID/);
});
