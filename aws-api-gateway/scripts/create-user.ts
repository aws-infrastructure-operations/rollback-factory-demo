/**
 * Creates (or resets the password of) a confirmed user in the environment's user pool.
 *
 * Usage: API_PASSWORD=... npx tsx scripts/create-user.ts --env dev --username me@example.com
 */
import {
  AdminCreateUserCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { log, parseCli, run } from './lib/cli.js';
import { requireStackOutputs } from './lib/stack.js';

run(async () => {
  const { config, values } = parseCli(['username'] as const);
  const username = values.username ?? process.env.API_USERNAME;
  const password = process.env.API_PASSWORD;
  if (!username || !password) throw new Error('Set API_USERNAME (or --username) and API_PASSWORD');

  const { UserPoolId } = await requireStackOutputs(config);
  const cognito = new CognitoIdentityProviderClient({});
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId,
      Username: username,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: username },
        { Name: 'email_verified', Value: 'true' },
      ],
    }));
    log(`Created ${username} in ${UserPoolId}`);
  } catch (err) {
    if (!(err instanceof UsernameExistsException)) throw err;
    log(`${username} already exists in ${UserPoolId}, resetting its password`);
  }
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId, Username: username, Password: password, Permanent: true,
  }));
  log('Password set (permanent)');
});
