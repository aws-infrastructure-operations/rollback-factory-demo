/**
 * Prints the CDK context that keeps the distribution on the release it serves now:
 *
 *   -c liveReleaseId=<id>
 *
 * Prints nothing when the stack doesn't exist yet (first deploy serves the placeholder).
 * Pass it to every `cdk deploy`, or the deploy resets the origin path and undoes the last
 * activation or rollback.
 *
 * Usage: npx tsx scripts/live-context.ts --env dev
 */
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { getLiveReleaseId } from '../lambda/shared/releases.js';
import { log, parseCli, run } from './lib/cli.js';
import { getFrontendOutputs } from './lib/stack.js';

run(async () => {
  const { config } = parseCli();
  const outputs = await getFrontendOutputs(config);
  if (!outputs?.DistributionId) {
    log(`${config.stackName} is not deployed yet - the first deploy serves the placeholder release`);
    return;
  }
  const releaseId = await getLiveReleaseId(new CloudFrontClient({ region: 'us-east-1' }), outputs.DistributionId);
  if (!releaseId) {
    log(`${outputs.DistributionId} doesn't serve a release path - the deploy resets it to the placeholder`);
    return;
  }
  log(`Keeping ${config.frontendName} on release ${releaseId}`);
  process.stdout.write(`-c liveReleaseId=${releaseId}\n`);
});
