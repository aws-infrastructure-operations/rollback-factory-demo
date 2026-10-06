/**
 * Run after release:activate: records the release the distribution now serves in the
 * deployments table, as current, and retires the previous record (stable / stableFor).
 * Skips if the latest record already has that release (nothing changed) unless --force.
 *
 * Usage: npx tsx scripts/record-deployment.ts --env dev [--release <id>] [--invalidation <id>]
 *        [--previous <id>] [--description "..."] [--force]
 *
 * --release only asserts which release should be live; the record always describes what the
 * distribution serves. --invalidation and --previous come from release:activate's output.
 * Source is "cicd" inside GitHub Actions (commit, actor and run URL from GITHUB_*),
 * otherwise "manual" with the caller's AWS identity as actor.
 */
import { getLiveReleaseId, INITIAL_RELEASE_ID, manifestKey, originPathFor } from '../lambda/shared/releases.js';
import { cloudfront, getManifest } from './lib/activate.js';
import { changeContext } from './lib/ci.js';
import { log, parseCli, run } from './lib/cli.js';
import { deploymentStore, requireFrontendOutputs } from './lib/stack.js';

run(async () => {
  const { config, values } = parseCli(['release', 'invalidation', 'previous', 'description'], ['force']);
  const outputs = await requireFrontendOutputs(config);
  const live = await getLiveReleaseId(cloudfront, outputs.DistributionId);
  if (!live || live === INITIAL_RELEASE_ID) {
    throw new Error(`${config.frontendName} serves ${live ?? 'no release'} - activate a release first`);
  }
  if (values.release && values.release !== live) {
    throw new Error(`${config.frontendName} serves ${live}, not ${values.release} - nothing recorded`);
  }
  // the manifest must exist: it is what a rollback or restore checks the release against
  const manifest = await getManifest(config, outputs, live);

  const { source, actor, commit, runUrl } = await changeContext();
  const record = await deploymentStore(config, outputs).record({
    frontendName: config.frontendName,
    releaseId: live,
    originPath: originPathFor(live),
    distributionId: outputs.DistributionId,
    manifestKey: manifestKey(config.frontendName, live),
    invalidationId: values.invalidation,
    previousReleaseId: values.previous,
    source,
    actor,
    // the commit the release was built from, not the one recording it
    commit: manifest.commit ?? commit,
    runUrl,
    description: values.description,
  }, { force: values.force });

  if (!record) {
    log(`${config.frontendName}: release ${live} is already the latest record - nothing recorded`);
    return;
  }
  log(`Recorded ${record.source} deployment of ${config.frontendName} release ${live} (deployedAt=${record.deployedAt})`);
  process.stdout.write(`${JSON.stringify(record)}\n`);
});
