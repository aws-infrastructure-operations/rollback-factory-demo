/**
 * Makes an uploaded release live: checks that every file of its manifest is in the site
 * bucket, points the distribution's origin path at releases/<id> and invalidates /*.
 * With --wait it waits for the distribution to deploy and the invalidation to finish and
 * prints how long each took. Record it afterwards with deployment:record.
 *
 * Prints the result as JSON on stdout ({ releaseId, previousReleaseId, invalidationId, ... }).
 *
 * Usage: npx tsx scripts/activate-release.ts --env dev --release 20261006T123005Z [--wait]
 */
import { activateRelease } from './lib/activate.js';
import { parseCli, run } from './lib/cli.js';
import { requireFrontendOutputs } from './lib/stack.js';

run(async () => {
  const { config, values } = parseCli(['release'], ['wait']);
  if (!values.release) throw new Error('Pass --release <id> (see npm run release:upload)');
  const activation = await activateRelease(config, await requireFrontendOutputs(config), values.release, { wait: values.wait });
  process.stdout.write(`${JSON.stringify(activation)}\n`);
});
