// A throw-away user of the dashboard's invite-only user pool, for the integration tests: created with
// a permanent password (no invitation email), signed in, and deleted when the tests are done.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AdminCreateUserCommand, AdminDeleteUserCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient, InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { FrontendOutputs } from '../../scripts/lib/stack.js';

/** The header the dashboard API reads the ID token from (lambda/dashboard-api/auth.ts). */
export const AUTH_HEADER = 'x-auth-token';

export interface TestUser {
  email: string;
  password: string;
  idToken: string;
  /** deletes the user */
  remove: () => Promise<void>;
}

const cognito = new CognitoIdentityProviderClient({});

/** Meets the pool's policy: 12+ characters with lower and upper case letters, a digit and a symbol. */
const password = () => `Aa1!${randomBytes(18).toString('base64url')}`;

export async function createTestUser(outputs: FrontendOutputs): Promise<TestUser> {
  const { DashboardUserPoolId: UserPoolId, DashboardUserPoolClientId: ClientId } = outputs;
  if (!UserPoolId || !ClientId) throw new Error('The stack has no DashboardUserPoolId / DashboardUserPoolClientId output - deploy it first');
  const email = `integration-${randomUUID()}@example.com`;
  const secret = password();
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId,
    Username: email,
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
    MessageAction: 'SUPPRESS',
  }));
  const remove = async () => { await cognito.send(new AdminDeleteUserCommand({ UserPoolId, Username: email })); };
  try {
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId, Username: email, Password: secret, Permanent: true }));
    const { AuthenticationResult } = await cognito.send(new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH', ClientId, AuthParameters: { USERNAME: email, PASSWORD: secret },
    }));
    if (!AuthenticationResult?.IdToken) throw new Error(`Signing in as ${email} returned no ID token`);
    return { email, password: secret, idToken: AuthenticationResult.IdToken, remove };
  } catch (err) {
    await remove().catch(() => undefined);
    throw err;
  }
}
