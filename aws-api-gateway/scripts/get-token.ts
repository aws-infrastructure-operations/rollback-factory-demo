/**
 * Logs in to the environment's Cognito user pool and prints the ID token
 * (the value the API's Cognito authorizer expects in the Authorization header).
 *
 * Usage:
 *   API_USERNAME=me@example.com API_PASSWORD=... npx tsx scripts/get-token.ts --env dev [--write-env]
 *
 * --write-env          also stores the token as ID_TOKEN_<ENV> in bruno/.env for the Bruno collection
 * USER_POOL_CLIENT_ID  skips the CloudFormation lookup of the app client id
 */
import { parseArgs } from 'node:util';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { getConfig } from '../lib/config.js';
import { log, run } from './lib/cli.js';
import { upsertDotenv } from './lib/dotenv.js';
import { BRUNO_DOTENV } from './lib/paths.js';
import { requireStackOutputs } from './lib/stack.js';

run(async () => {
  const { values } = parseArgs({
    options: {
      env: { type: 'string' },
      username: { type: 'string' },
      'write-env': { type: 'boolean', default: false },
    },
  });
  const config = getConfig(values.env ?? process.env.API_ENV ?? 'dev');
  const username = values.username ?? process.env.API_USERNAME;
  const password = process.env.API_PASSWORD;
  if (!username || !password) throw new Error('Set API_USERNAME (or --username) and API_PASSWORD');

  const clientId = process.env.USER_POOL_CLIENT_ID ?? (await requireStackOutputs(config)).UserPoolClientId;
  const { AuthenticationResult, ChallengeName } = await new CognitoIdentityProviderClient({}).send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  if (!AuthenticationResult?.IdToken) {
    throw new Error(`No token returned${ChallengeName ? ` (challenge: ${ChallengeName})` : ''}`);
  }

  const envKey = `ID_TOKEN_${config.envName.toUpperCase()}`;
  if (values['write-env']) {
    upsertDotenv(BRUNO_DOTENV, envKey, AuthenticationResult.IdToken);
    log(`Stored ${envKey} in bruno/.env`);
  }
  process.stdout.write(`${AuthenticationResult.IdToken}\n`);
});
