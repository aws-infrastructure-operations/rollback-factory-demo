/**
 * Manages who may sign in to the dashboard of an environment: the users of its invite-only user pool
 * (rollback-factory-demo-dashboard-users-<env>). Nobody can sign up; only these commands (or the
 * Cognito console) add users.
 *
 * Usage:
 *   npx tsx scripts/users.ts --env dev --action list
 *   npx tsx scripts/users.ts --env dev --action invite --email jane@example.com   # Cognito emails a temporary password
 *   npx tsx scripts/users.ts --env dev --action resend --email jane@example.com   # a new temporary password, if it expired
 *   npx tsx scripts/users.ts --env dev --action remove --email jane@example.com   # signs them out everywhere, then deletes them
 */
import {
  AdminCreateUserCommand, AdminDeleteUserCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient, paginateListUsers,
} from '@aws-sdk/client-cognito-identity-provider';
import { log, parseCli, run } from './lib/cli.js';
import { requireFrontendOutputs } from './lib/stack.js';

const ACTIONS = ['list', 'invite', 'resend', 'remove'] as const;
const cognito = new CognitoIdentityProviderClient({});

run(async () => {
  const { config, values } = parseCli(['action', 'email']);
  const action = values.action as (typeof ACTIONS)[number];
  if (!ACTIONS.includes(action)) throw new Error(`--action must be one of ${ACTIONS.join(', ')}`);
  const email = values.email?.trim().toLowerCase();
  if (action !== 'list' && !email?.includes('@')) throw new Error(`--action ${action} needs --email <address>`);

  const { DashboardUserPoolId: UserPoolId } = await requireFrontendOutputs(config);
  if (!UserPoolId) throw new Error(`${config.stackName} has no DashboardUserPoolId output: deploy the frontend first`);

  if (action === 'list') {
    for await (const page of paginateListUsers({ client: cognito }, { UserPoolId })) {
      for (const user of page.Users ?? []) {
        const mail = user.Attributes?.find((a) => a.Name === 'email')?.Value ?? user.Username;
        process.stdout.write(`${mail}\t${user.UserStatus}\t${user.Enabled ? 'enabled' : 'disabled'}\t${user.UserCreateDate?.toISOString()}\n`);
      }
    }
    return;
  }
  if (action === 'invite' || action === 'resend') {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId,
      Username: email,
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
      DesiredDeliveryMediums: ['EMAIL'],
      ...(action === 'resend' && { MessageAction: 'RESEND' }),
    }));
    log(`${action === 'invite' ? 'Invited' : 'Sent a new temporary password to'} ${email} (${config.frontendName} dashboard)`);
    return;
  }
  await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId, Username: email }));
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId, Username: email }));
  log(`Removed ${email}: signed out everywhere and deleted`);
});
