/**
 * Restores a release you choose (any release with a manifest, e.g. from deployment:list):
 * activates it and records a "restore". Use it to recover when the live site is in a bad
 * state. The restored release is not verified until the integration tests pass again
 * (deployment:verify).
 *
 * Usage: npx tsx scripts/restore-deployment.ts --env dev --release 20261006T123005Z [--reason "..."] [--wait]
 */
import { manifestKey, originPathFor } from '../lambda/shared/releases.js';
import { activateRelease } from './lib/activate.js';
import { changeContext } from './lib/ci.js';
import { log, parseCli, run } from './lib/cli.js';
import { deploymentStore, requireFrontendOutputs } from './lib/stack.js';

run(async () => {
  const { config, values } = parseCli(['release', 'reason'], ['wait']);
  if (!values.release) throw new Error('Pass --release <id> (see npm run deployment:list)');
  const outputs = await requireFrontendOutputs(config);

  log(`Restoring ${config.frontendName} to release ${values.release}`);
  const activation = await activateRelease(config, outputs, values.release, { wait: values.wait });

  const { actor, commit, runUrl } = await changeContext();
  const record = await deploymentStore(config, outputs).record({
    frontendName: config.frontendName,
    releaseId: activation.releaseId,
    originPath: originPathFor(activation.releaseId),
    distributionId: outputs.DistributionId,
    manifestKey: manifestKey(config.frontendName, activation.releaseId),
    invalidationId: activation.invalidationId,
    previousReleaseId: activation.previousReleaseId,
    source: 'restore',
    actor,
    commit,
    runUrl,
    description: values.reason,
  });
  log(record
    ? `Recorded the restore (deployedAt=${record.deployedAt})`
    : `Release ${activation.releaseId} was already the latest record - nothing recorded`);
  process.stdout.write(`${JSON.stringify({ ...activation, record })}\n`);
});
