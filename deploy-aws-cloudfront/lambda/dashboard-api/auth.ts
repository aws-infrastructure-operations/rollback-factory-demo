// Sign-in for the dashboard: every /api/* call but GET /api/auth/config needs the ID token of a user
// of the dashboard's Cognito user pool (rollback-factory-demo-dashboard-users-<env>, invite only).
//
// The token comes in x-auth-token, not Authorization: CloudFront signs each request to the function
// URL (Origin Access Control) and puts its signature in Authorization, replacing the viewer's.
import { CognitoJwtVerifier } from 'aws-jwt-verify';

export const AUTH_HEADER = 'x-auth-token';

/** What the page needs to sign in against the user pool (GET /api/auth/config). */
export interface AuthConfig {
  region: string;
  userPoolId: string;
  clientId: string;
}

/** The signed-in user. */
export interface User {
  /** Cognito's sub: never changes, even if the email does */
  sub: string;
  email: string;
}

/** Checks an ID token: signature, issuer (the pool), audience (the client), token use and expiry. */
export type VerifyIdToken = (token: string) => Promise<{ sub: string; email?: unknown }>;

export function authConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const { AWS_REGION: region, USER_POOL_ID: userPoolId, USER_POOL_CLIENT_ID: clientId } = env;
  if (!region || !userPoolId || !clientId) throw new Error('AWS_REGION, USER_POOL_ID and USER_POOL_CLIENT_ID must be set');
  return { region, userPoolId, clientId };
}

/**
 * aws-jwt-verify, which fetches and caches the pool's signing keys (JWKS) across invocations.
 * Tests pass `jwks` instead, so nothing is fetched.
 */
export function cognitoVerifier(config: AuthConfig, jwks?: Parameters<ReturnType<typeof CognitoJwtVerifier.create>['cacheJwks']>[0]): VerifyIdToken {
  const verifier = CognitoJwtVerifier.create({ userPoolId: config.userPoolId, clientId: config.clientId, tokenUse: 'id' });
  if (jwks) verifier.cacheJwks(jwks);
  return (token) => verifier.verify(token) as Promise<{ sub: string; email?: unknown }>;
}

/**
 * The user whose ID token the request carries, or undefined: no token, or one the pool didn't issue
 * to this client, that expired, or that isn't an ID token. Function URL events have lower-case headers.
 */
export async function authenticate(headers: Record<string, string | undefined> | undefined, verify: VerifyIdToken): Promise<User | undefined> {
  const token = headers?.[AUTH_HEADER];
  if (!token) return undefined;
  try {
    const claims = await verify(token);
    return { sub: claims.sub, email: typeof claims.email === 'string' ? claims.email : claims.sub };
  } catch (err) {
    // an expired or forged token is the caller's problem, not the API's: log why, answer 401
    console.warn('Rejected a token:', err instanceof Error ? err.message : err);
    return undefined;
  }
}
