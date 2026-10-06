import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CognitoError, createCognitoClient } from '../app/src/cognito.js';
import { createSessionStore, decodeJwtPayload, getValidSession, KeyValueStore, Session } from '../app/src/session.js';
import { createApiClient } from '../app/src/api.js';

interface Call { url: string; init: RequestInit }

/** A fetch that records calls and answers with the given responses in order. */
const fakeFetch = (...responses: Array<{ status?: number; body: unknown }>) => {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 500, body: { message: 'no more responses' } };
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
};

const jwt = (payload: Record<string, unknown>) =>
  ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

const memoryStorage = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

const NOW = Date.parse('2026-10-06T12:00:00Z');
const tokenValidFor = (seconds: number) => jwt({ exp: NOW / 1000 + seconds, email: 'me@example.com' });

// --- Cognito ------------------------------------------------------------------

test('signs in with USER_PASSWORD_AUTH against the region endpoint', async () => {
  const { fn, calls } = fakeFetch({ body: { AuthenticationResult: { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh' } } });
  const cognito = createCognitoClient({ region: 'eu-central-1', clientId: 'client', fetch: fn });

  const result = await cognito.signIn('me@example.com', 'secret');

  assert.deepEqual(result, { kind: 'signedIn', tokens: { idToken: 'id', accessToken: 'access', refreshToken: 'refresh' } });
  assert.equal(calls[0].url, 'https://cognito-idp.eu-central-1.amazonaws.com/');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['X-Amz-Target'], 'AWSCognitoIdentityProviderService.InitiateAuth');
  assert.equal(headers['Content-Type'], 'application/x-amz-json-1.1');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: 'client',
    AuthParameters: { USERNAME: 'me@example.com', PASSWORD: 'secret' },
  });
});

test('returns the NEW_PASSWORD_REQUIRED challenge and completes it', async () => {
  const { fn, calls } = fakeFetch(
    { body: { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'challenge-session' } },
    { body: { AuthenticationResult: { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh' } } },
  );
  const cognito = createCognitoClient({ region: 'eu-central-1', clientId: 'client', fetch: fn });

  assert.deepEqual(await cognito.signIn('me@example.com', 'temporary'), { kind: 'newPasswordRequired', session: 'challenge-session' });
  const done = await cognito.completeNewPassword('me@example.com', 'a-new-password!', 'challenge-session');

  assert.equal(done.kind, 'signedIn');
  assert.equal((calls[1].init.headers as Record<string, string>)['X-Amz-Target'], 'AWSCognitoIdentityProviderService.RespondToAuthChallenge');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ClientId: 'client',
    Session: 'challenge-session',
    ChallengeResponses: { USERNAME: 'me@example.com', NEW_PASSWORD: 'a-new-password!' },
  });
});

test('turns Cognito errors into CognitoError with the short code and message', async () => {
  const { fn } = fakeFetch({ status: 400, body: { __type: 'com.amazonaws#NotAuthorizedException', message: 'Incorrect username or password.' } });
  const cognito = createCognitoClient({ region: 'eu-central-1', clientId: 'client', fetch: fn });

  await assert.rejects(cognito.signIn('me@example.com', 'wrong'), (err: unknown) => {
    assert.ok(err instanceof CognitoError);
    assert.equal(err.code, 'NotAuthorizedException');
    assert.equal(err.message, 'Incorrect username or password.');
    return true;
  });
});

test('refresh keeps the existing refresh token', async () => {
  const { fn, calls } = fakeFetch({ body: { AuthenticationResult: { IdToken: 'id2', AccessToken: 'access2' } } });
  const cognito = createCognitoClient({ region: 'eu-central-1', clientId: 'client', fetch: fn });

  assert.deepEqual(await cognito.refresh('refresh'), { idToken: 'id2', accessToken: 'access2', refreshToken: 'refresh' });
  assert.equal(JSON.parse(String(calls[0].init.body)).AuthFlow, 'REFRESH_TOKEN_AUTH');
});

// --- Session ------------------------------------------------------------------

test('decodes base64url JWT payloads, including non-ASCII claims', () => {
  assert.deepEqual(decodeJwtPayload(jwt({ email: 'zoë@example.com', exp: 1 })), { email: 'zoë@example.com', exp: 1 });
});

test('returns a fresh session without calling Cognito', async () => {
  const sessions = createSessionStore(memoryStorage(), () => NOW);
  const session: Session = { username: 'me@example.com', idToken: tokenValidFor(3600), accessToken: 'a', refreshToken: 'r' };
  sessions.save(session);
  const cognito = createCognitoClient({ region: 'r', clientId: 'c', fetch: fakeFetch().fn });

  assert.deepEqual(await getValidSession(sessions, cognito), session);
});

test('refreshes a session whose ID token is about to expire', async () => {
  const sessions = createSessionStore(memoryStorage(), () => NOW);
  sessions.save({ username: 'me@example.com', idToken: tokenValidFor(30), accessToken: 'a', refreshToken: 'r' });
  const fresh = tokenValidFor(3600);
  const cognito = createCognitoClient({
    region: 'r', clientId: 'c',
    fetch: fakeFetch({ body: { AuthenticationResult: { IdToken: fresh, AccessToken: 'a2' } } }).fn,
  });

  const session = await getValidSession(sessions, cognito);

  assert.equal(session?.idToken, fresh);
  assert.equal(session?.refreshToken, 'r');
  assert.equal(sessions.load()?.idToken, fresh, 'the refreshed tokens are stored');
});

test('forgets the session when Cognito rejects the refresh token', async () => {
  const sessions = createSessionStore(memoryStorage(), () => NOW);
  sessions.save({ username: 'me@example.com', idToken: tokenValidFor(-10), accessToken: 'a', refreshToken: 'r' });
  const cognito = createCognitoClient({
    region: 'r', clientId: 'c',
    fetch: fakeFetch({ status: 400, body: { __type: 'NotAuthorizedException', message: 'Refresh Token has expired' } }).fn,
  });

  assert.equal(await getValidSession(sessions, cognito), undefined);
  assert.equal(sessions.load(), undefined);
});

test('keeps the session on network errors during refresh', async () => {
  const sessions = createSessionStore(memoryStorage(), () => NOW);
  sessions.save({ username: 'me@example.com', idToken: tokenValidFor(-10), accessToken: 'a', refreshToken: 'r' });
  const offline = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
  const cognito = createCognitoClient({ region: 'r', clientId: 'c', fetch: offline });

  await assert.rejects(getValidSession(sessions, cognito), TypeError);
  assert.ok(sessions.load(), 'still signed in');
});

test('ignores corrupt stored sessions', () => {
  const storage = memoryStorage();
  storage.setItem('frontend-user.session', '{not json');
  assert.equal(createSessionStore(storage).load(), undefined);
});

// --- API ----------------------------------------------------------------------

test('GET sends the raw ID token to <stage url>/<resource>', async () => {
  const { fn, calls } = fakeFetch({ body: { message: 'Hello', users: [] } });
  const api = createApiClient({ baseUrl: 'https://abc.execute-api.eu-central-1.amazonaws.com/v1', getIdToken: async () => 'id-token', fetch: fn });

  const response = await api.get('users');

  assert.deepEqual(response, { status: 200, ok: true, body: { message: 'Hello', users: [] } });
  assert.equal(calls[0].url, 'https://abc.execute-api.eu-central-1.amazonaws.com/v1/users');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(calls[0].init.headers, { Authorization: 'id-token' });
  assert.equal(calls[0].init.body, undefined);
});

test('POST sends { message } as JSON', async () => {
  const { fn, calls } = fakeFetch({ status: 201, body: { echo: 'hi' } });
  const api = createApiClient({ baseUrl: 'https://abc.execute-api.eu-central-1.amazonaws.com/v1/', getIdToken: async () => 'id-token', fetch: fn });

  const response = await api.post('messages', 'hi');

  assert.equal(response.status, 201);
  assert.equal(calls[0].url, 'https://abc.execute-api.eu-central-1.amazonaws.com/v1/messages');
  assert.deepEqual(calls[0].init.headers, { Authorization: 'id-token', 'Content-Type': 'application/json' });
  assert.equal(calls[0].init.body, JSON.stringify({ message: 'hi' }));
});

test('returns error responses and non-JSON bodies as they are', async () => {
  const { fn } = fakeFetch({ status: 401, body: { message: 'Unauthorized' } }, { status: 502, body: 'Bad Gateway' });
  const api = createApiClient({ baseUrl: 'https://x/v1/', getIdToken: async () => 't', fetch: fn });

  assert.deepEqual(await api.get('users'), { status: 401, ok: false, body: { message: 'Unauthorized' } });
  assert.deepEqual(await api.get('messages'), { status: 502, ok: false, body: 'Bad Gateway' });
});
