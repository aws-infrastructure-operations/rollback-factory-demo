/**
 * Marks the deployment the distribution currently serves as verified (run it after the
 * integration tests passed). The rollback Lambda only goes back to verified deployments,
 * so an untested or broken release is never restored automatically.
 *
 * Usage: npx tsx scripts/verify-deployment.ts --env dev [--release <id>]
 */
import { getLiveReleaseId } from '../lambda/shared/releases.js';
import { cloudfront } from './lib/activate.js';
import { log, parseCli, run } from './lib/cli.js';
import { deploymentStore, requireFrontendOutputs } from './lib/stack.js';

run(async () => {
  const { config, values } = parseCli(['release']);
  const outputs = await requireFrontendOutputs(config);
  const store = deploymentStore(config, outputs);
  const live = await getLiveReleaseId(cloudfront, outputs.DistributionId);
  const latest = await store.latest();

  // Only the latest record may be verified, and only if the distribution really serves it -
  // otherwise the tests passed against something else.
  if (!latest || latest.releaseId !== live) {
    throw new Error(
      `${config.frontendName} serves release ${live ?? '(none)'}, but the latest record is `
      + `${latest ? `${latest.releaseId} (${latest.deployedAt})` : 'missing'} - record the deployment first`,
    );
  }
  if (values.release && values.release !== live) {
    throw new Error(`${config.frontendName} serves ${live}, not ${values.release} - nothing verified`);
  }
  await store.markVerified(latest);
  log(`Verified release ${latest.releaseId} of ${config.frontendName} (${latest.deployedAt}, ${latest.source})`);
});
