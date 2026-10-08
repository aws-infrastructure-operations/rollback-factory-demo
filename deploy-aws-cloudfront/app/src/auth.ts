// Sign-in against the dashboard's invite-only Cognito user pool. The page talks to Cognito's public
// API straight from the browser (InitiateAuth with USER_PASSWORD_AUTH, over HTTPS); which pool and
// client it uses comes from GET /api/auth/config, so one release works on both distributions.
// Every /api/* call then carries the ID token in x-auth-token (api.ts; checked by lambda/dashboard-api/auth.ts).

export interface AuthConfig {
  region: string;
  userPoolId: string;
  clientId: string;
}

interface Session {
  idToken: string;
  refreshToken: string;
  /** ms since the epoch: when the ID token expires */
  expiresAt: number;
  email: string;
}

/** Cognito answered with an error; `type` is its exception name, e.g. NotAuthorizedException. */
export class AuthError extends Error {
  constructor(readonly type: string, message: string) {
    super(message);
  }
}

/** Invited users sign in with a temporary password first and must choose their own. */
export interface NewPasswordRequired {
  challenge: 'NEW_PASSWORD_REQUIRED';
  email: string;
  /** Cognito's session for RespondToAuthChallenge */
  session: string;
}

/** The header the dashboard API reads the ID token from (lambda/dashboard-api/auth.ts: AUTH_HEADER). */
export const AUTH_HEADER_NAME = 'x-auth-token';

const STORAGE_KEY = 'rollback-dashboard-session';
/** Refresh the ID token this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;

let config: AuthConfig | undefined;
let session: Session | undefined = readStored();
let refreshing: Promise<string | undefined> | undefined;
const listeners = new Set<() => void>();

// Storage can be unavailable (private windows, blocked site data): sign-in then lasts for the page only.
function readStored(): Session | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as Session : undefined;
  } catch {
    return undefined;
  }
}

function store(next: Session | undefined) {
  session = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* kept in memory only */ }
  for (const listener of listeners) listener();
}

/** Called whenever the user signs in or out (also when a session can't be refreshed). */
export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The signed-in user's email, or undefined when signed out. */
export const currentUser = (): string | undefined => session?.email;

export async function loadAuthConfig(): Promise<AuthConfig> {
  if (config) return config;
  const response = await fetch('/api/auth/config', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET /api/auth/config answered ${response.status}`);
  config = await response.json() as AuthConfig;
  return config;
}

/** One call to Cognito's user pool API (the operations a signed-out browser may call). */
async function cognito<T>(operation: string, body: Record<string, unknown>): Promise<T> {
  const { region } = await loadAuthConfig();
  const response = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${operation}`,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const type = String(data.__type ?? 'Error').split('#').pop()!;
    throw new AuthError(type, data.message ?? `${operation} failed (${response.status})`);
  }
  return data as T;
}

interface AuthResult {
  AuthenticationResult?: { IdToken: string; RefreshToken?: string; ExpiresIn: number };
  ChallengeName?: string;
  Session?: string;
}

/** The claims of a JWT, unchecked: only to read the email and expiry the API checks for real. */
function claimsOf(token: string): { email?: string; exp?: number } {
  const binary = atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
}

function signedIn(result: AuthResult['AuthenticationResult'], refreshToken: string): string {
  const claims = claimsOf(result!.IdToken);
  store({
    idToken: result!.IdToken,
    refreshToken,
    expiresAt: (claims.exp ?? Date.now() / 1000 + result!.ExpiresIn) * 1000,
    email: claims.email ?? '',
  });
  return result!.IdToken;
}

/** Signs in with email and password. An invited user's first sign-in asks for a new password. */
export async function signIn(email: string, password: string): Promise<NewPasswordRequired | undefined> {
  const { clientId } = await loadAuthConfig();
  const result = await cognito<AuthResult>('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    return { challenge: 'NEW_PASSWORD_REQUIRED', email, session: result.Session! };
  }
  if (!result.AuthenticationResult) throw new AuthError(result.ChallengeName ?? 'Error', `Sign-in step ${result.ChallengeName} isn't supported`);
  signedIn(result.AuthenticationResult, result.AuthenticationResult.RefreshToken!);
  return undefined;
}

/** Sets the invited user's own password (the NEW_PASSWORD_REQUIRED challenge) and signs them in. */
export async function completeNewPassword(challenge: NewPasswordRequired, newPassword: string): Promise<void> {
  const { clientId } = await loadAuthConfig();
  const result = await cognito<AuthResult>('RespondToAuthChallenge', {
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ClientId: clientId,
    Session: challenge.session,
    ChallengeResponses: { USERNAME: challenge.email, NEW_PASSWORD: newPassword },
  });
  if (!result.AuthenticationResult) throw new AuthError(result.ChallengeName ?? 'Error', `Sign-in step ${result.ChallengeName} isn't supported`);
  signedIn(result.AuthenticationResult, result.AuthenticationResult.RefreshToken!);
}

/**
 * A valid ID token for the next /api/* call: the stored one, or a refreshed one when it is about to
 * expire (`force`: the API rejected it). Undefined, and signed out, when the session can't be refreshed.
 */
export async function idToken(force = false): Promise<string | undefined> {
  if (!session) return undefined;
  if (!force && session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.idToken;
  // one refresh at a time, however many calls need it
  refreshing ??= (async () => {
    try {
      const { clientId } = await loadAuthConfig();
      const result = await cognito<AuthResult>('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: session!.refreshToken },
      });
      return signedIn(result.AuthenticationResult, session!.refreshToken);
    } catch {
      // expired, revoked, or the user was removed: back to the sign-in form
      store(undefined);
      return undefined;
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}

/** Signs out here, and revokes the refresh token so it can't be used again anywhere. */
export async function signOut(): Promise<void> {
  const refreshToken = session?.refreshToken;
  store(undefined);
  if (!refreshToken) return;
  try {
    const { clientId } = await loadAuthConfig();
    await cognito('RevokeToken', { Token: refreshToken, ClientId: clientId });
  } catch { /* signed out locally either way */ }
}
