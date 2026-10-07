/**
 * Prints the CDK context that keeps stage v1 and each backend's `live` alias where they
 * are, so `cdk deploy` only updates the integration stage (and the `integration` aliases):
 *
 *   -c liveDeploymentId=<v1 deployment> -c liveUsersVersion=<n> -c liveMessagesVersion=<n> -c liveOrdersVersion=<n>
 *
 * Prints nothing for a value that doesn't exist yet (first deploy): that part is then
 * deployed directly. Used by CI before `cdk deploy`; scripts/promote-deployment.ts moves
 * v1 and the aliases after the integration tests passed. Keeping `live` also keeps a
 * rollback the rollback service made.
 *
 * Usage: npx tsx scripts/live-context.ts --env dev
 */
import { BACKENDS, liveVersionContextKey } from '../lib/config.js';
import { getAliasVersion, getStageDeploymentId } from '../lambda/shared/deployments.js';
import { log, parseCli, run } from './lib/cli.js';
import { getStackOutputs } from './lib/stack.js';

run(async () => {
  const { config } = parseCli();
  const outputs = await getStackOutputs(config);
  if (!outputs?.ApiId) {
    log(`${config.stackName} is not deployed yet - the first deploy goes straight to ${config.stageName}`);
    return;
  }

  const args: string[] = [];
  try {
    args.push(`-c liveDeploymentId=${await getStageDeploymentId(outputs.ApiId, config.stageName)}`);
  } catch (err) {
    if (!(err instanceof Error && err.name === 'NotFoundException')) throw err;
    log(`Stage ${config.stageName} doesn't exist yet - it gets the new deployment`);
  }
  for (const backend of BACKENDS) {
    const { functionName } = config.backends[backend];
    const version = await getAliasVersion(functionName, 'live');
    if (version) args.push(`-c ${liveVersionContextKey(backend)}=${version}`);
    else log(`${functionName} has no live alias yet - it gets the new version`);
  }

  log(`Keeping ${config.stageName} where it is: ${args.join(' ') || '(nothing to keep)'}`);
  process.stdout.write(`${args.join(' ')}\n`);
});
