import { randomBytes } from 'node:crypto';
import {
  AdminCreateUserCommand, AdminDeleteUserCommand, AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient, InitiateAuthCommand, UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});

/** Creates a confirmed user with a permanent password. Returns false if it already existed. */
export async function ensureUser(userPoolId: string, username: string, password: string): Promise<boolean> {
  let created = true;
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: username },
        { Name: 'email_verified', Value: 'true' },
      ],
    }));
  } catch (err) {
    if (!(err instanceof UsernameExistsException)) throw err;
    created = false;
  }
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId, Username: username, Password: password, Permanent: true,
  }));
  return created;
}

export async function deleteUser(userPoolId: string, username: string) {
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
}

/** USER_PASSWORD_AUTH login; returns the ID token the API's Cognito authorizer expects. */
export async function getIdToken(clientId: string, username: string, password: string): Promise<string> {
  const { AuthenticationResult, ChallengeName } = await cognito.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  }));
  if (!AuthenticationResult?.IdToken) {
    throw new Error(`No token returned${ChallengeName ? ` (challenge: ${ChallengeName})` : ''}`);
  }
  return AuthenticationResult.IdToken;
}

/** Password that satisfies the user pool policy (12+ chars, upper, lower, digit, symbol). */
export const randomPassword = () => `Aa1!${randomBytes(18).toString('base64url')}`;
