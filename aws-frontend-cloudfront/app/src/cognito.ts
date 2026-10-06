// Minimal Cognito user pool client: plain fetch against the cognito-idp JSON API, no Amplify.
// The API's user pool client is public (no secret) and allows USER_PASSWORD_AUTH.

export interface Tokens {
  idToken: string;
  accessToken: string;
  /** Only returned on sign-in; a refresh keeps the existing one. */
  refreshToken?: string;
}

export type SignInResult =
  | { kind: 'signedIn'; tokens: Tokens }
  /** Users created by an admin must set their own password on first sign-in. */
  | { kind: 'newPasswordRequired'; session: string };

export class CognitoError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CognitoError';
  }
}

export interface CognitoClientOptions {
  region: string;
  clientId: string;
  fetch?: typeof fetch;
}

export type CognitoClient = ReturnType<typeof createCognitoClient>;

export function createCognitoClient({ region, clientId, fetch: fetchFn = fetch }: CognitoClientOptions) {
  const endpoint = `https://cognito-idp.${region}.amazonaws.com/`;

  const call = async (action: string, body: Record<string, unknown>): Promise<any> => {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
      },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      // __type is "NotAuthorizedException" or "<namespace>#NotAuthorizedException"
      const code = String(data.__type ?? `HTTP${res.status}`).split('#').pop()!;
      throw new CognitoError(code, data.message ?? `Cognito ${action} failed with HTTP ${res.status}`);
    }
    return data;
  };

  const toResult = (data: any): SignInResult => {
    const auth = data.AuthenticationResult;
    if (auth) {
      return {
        kind: 'signedIn',
        tokens: { idToken: auth.IdToken, accessToken: auth.AccessToken, refreshToken: auth.RefreshToken },
      };
    }
    if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') return { kind: 'newPasswordRequired', session: data.Session };
    throw new CognitoError('UnsupportedChallenge', `Sign-in needs ${data.ChallengeName}, which this app doesn't support`);
  };

  return {
    async signIn(username: string, password: string): Promise<SignInResult> {
      return toResult(await call('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }));
    },

    async completeNewPassword(username: string, newPassword: string, session: string): Promise<SignInResult> {
      return toResult(await call('RespondToAuthChallenge', {
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        ClientId: clientId,
        Session: session,
        ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPassword },
      }));
    },

    async refresh(refreshToken: string): Promise<Tokens> {
      const result = toResult(await call('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }));
      if (result.kind !== 'signedIn') throw new CognitoError('UnexpectedChallenge', 'Token refresh returned a challenge');
      return { ...result.tokens, refreshToken: result.tokens.refreshToken ?? refreshToken };
    },
  };
}
