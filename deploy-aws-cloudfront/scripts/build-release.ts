/**
 * Builds the app for one environment as a new release: runs the Vite build into dist/ with the
 * environment, release id and build time, and writes release.json for release:upload.
 *
 * Usage: npx tsx scripts/build-release.ts --env dev [--release 20261006T123005Z]
 */
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { assertReleaseId, releaseIdFor } from '../lambda/shared/releases.js';
import { log, parseCli, run } from './lib/cli.js';
import { PROJECT_ROOT, RELEASE_FILE } from './lib/paths.js';

export interface BuiltRelease {
  releaseId: string;
  env: string;
  frontendName: string;
  builtAt: string;
}

run(async () => {
  const { config, values } = parseCli(['release']);
  const now = new Date();
  const releaseId = values.release ?? releaseIdFor(now);
  assertReleaseId(releaseId);
  log(`Building ${config.frontendName} release ${releaseId}`);

  const vite = spawnSync(
    process.execPath,
    [path.join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', 'app'],
    {
      cwd: PROJECT_ROOT,
      // Vite's output goes to stderr: stdout only carries the release id (for CI and deploy.ts)
      stdio: ['ignore', 2, 'inherit'],
      env: {
        ...process.env,
        VITE_ENV: config.envName,
        VITE_RELEASE_ID: releaseId,
        VITE_BUILT_AT: now.toISOString(),
      },
    },
  );
  if (vite.status !== 0) throw new Error(`vite build failed (exit ${vite.status ?? vite.signal})`);

  const release: BuiltRelease = {
    releaseId,
    env: config.envName,
    frontendName: config.frontendName,
    builtAt: now.toISOString(),
  };
  await writeFile(RELEASE_FILE, `${JSON.stringify(release, null, 2)}\n`);
  log(`Built release ${releaseId} into dist/ (details in release.json)`);
  process.stdout.write(`${releaseId}\n`);
});
