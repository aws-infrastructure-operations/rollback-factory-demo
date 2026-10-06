/**
 * Prints the CDK context that keeps both distributions on the releases they serve now:
 *
 *   -c liveReleaseId=<id> -c integrationReleaseId=<id>
 *
 * Leaves out a distribution that doesn't exist yet or doesn't serve a release path (it then
 * serves the placeholder after the deploy). Pass it to every `cdk deploy`, or the deploy resets
 * the origin paths and undoes the last activation or rollback.
 *
 * Usage: npx tsx scripts/live-context.ts --env dev
 */
import { getLiveReleaseId } from '../lambda/shared/releases.js';
import { cloudfront } from './lib/activate.js';
import { log, parseCli, run } from './lib/cli.js';
import { getFrontendOutputs } from './lib/stack.js';

run(async () => {
  const { config } = parseCli();
  const outputs = await getFrontendOutputs(config);
  const distributions = [
    { context: 'liveReleaseId', name: config.frontendName, id: outputs?.DistributionId },
    { context: 'integrationReleaseId', name: config.integrationName, id: outputs?.IntegrationDistributionId },
  ];

  const args: string[] = [];
  for (const { context, name, id } of distributions) {
    if (!id) {
      log(`${name} doesn't exist yet - the deploy creates it with the placeholder release`);
      continue;
    }
    const releaseId = await getLiveReleaseId(cloudfront, id);
    if (!releaseId) {
      log(`${name} (${id}) doesn't serve a release path - the deploy resets it to the placeholder`);
      continue;
    }
    log(`Keeping ${name} on release ${releaseId}`);
    args.push(`-c ${context}=${releaseId}`);
  }
  process.stdout.write(`${args.join(' ')}\n`);
});
