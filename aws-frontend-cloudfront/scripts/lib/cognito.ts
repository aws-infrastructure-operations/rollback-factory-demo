import { randomBytes } from 'node:crypto';
import {
  AdminCreateUserCommand, AdminDeleteUserCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

/** User pool ids are "<region>_<id>". */
const clientFor = (userPoolId: string) => new CognitoIdentityProviderClient({ region: userPoolId.split('_')[0] });

/** Creates a confirmed user with a permanent password (same as the API's test users). */
export async function createUser(userPoolId: string, username: string, password: string) {
  const cognito = clientFor(userPoolId);
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: userPoolId,
    Username: username,
    MessageAction: 'SUPPRESS',
    UserAttributes: [
      { Name: 'email', Value: username },
      { Name: 'email_verified', Value: 'true' },
    ],
  }));
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId, Username: username, Password: password, Permanent: true,
  }));
}

export async function deleteUser(userPoolId: string, username: string) {
  await clientFor(userPoolId).send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
}

/** Password that satisfies the user pool policy (12+ chars, upper, lower, digit, symbol). */
export const randomPassword = () => `Aa1!${randomBytes(18).toString('base64url')}`;
