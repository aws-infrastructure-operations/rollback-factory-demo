/**
 * Creates (or resets the password of) a confirmed user in the environment's user pool.
 *
 * Usage: API_PASSWORD=... npx tsx scripts/create-user.ts --env dev --username me@example.com
 */
import { log, parseCli, run } from './lib/cli.js';
import { ensureUser } from './lib/cognito.js';
import { requireStackOutputs } from './lib/stack.js';

run(async () => {
  const { config, values } = parseCli(['username'] as const);
  const username = values.username ?? process.env.API_USERNAME;
  const password = process.env.API_PASSWORD;
  if (!username || !password) throw new Error('Set API_USERNAME (or --username) and API_PASSWORD');

  const { UserPoolId } = await requireStackOutputs(config);
  const created = await ensureUser(UserPoolId, username, password);
  log(created
    ? `Created ${username} in ${UserPoolId}`
    : `${username} already exists in ${UserPoolId}, password reset`);
});
