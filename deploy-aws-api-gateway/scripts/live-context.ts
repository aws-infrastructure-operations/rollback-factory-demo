/**
 * Prints the CDK context that keeps stage v1 and the handler's `live` alias where they
 * are, so `cdk deploy` only updates the integration stage (and its alias):
 *
 *   -c liveDeploymentId=<v1 deployment> -c liveLambdaVersion=<live alias version>
 *
 * Prints nothing for a value that doesn't exist yet (first deploy): that part is then
 * deployed directly. Used by CI before `cdk deploy`; scripts/promote-deployment.ts moves
 * v1 after the integration tests passed.
 *
 * Usage: npx tsx scripts/live-context.ts --env dev
 */
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
  const version = await getAliasVersion(config.resourceName('handler'), 'live');
  if (version) args.push(`-c liveLambdaVersion=${version}`);
  else log('Alias live doesn\'t exist yet - it gets the new version');

  log(`Keeping ${config.stageName} where it is: ${args.join(' ') || '(nothing to keep)'}`);
  process.stdout.write(`${args.join(' ')}\n`);
});
