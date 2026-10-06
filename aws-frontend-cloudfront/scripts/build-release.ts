/**
 * Builds the app for one environment as a new release: reads the api-user stack outputs
 * (API URL, user pool, client), runs the Vite build into dist/ and writes release.json
 * for release:upload.
 *
 * Usage: npx tsx scripts/build-release.ts --env dev [--release 20261006T123005Z]
 */
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { assertReleaseId, releaseIdFor } from '../lambda/shared/releases.js';
import { log, parseCli, run } from './lib/cli.js';
import { PROJECT_ROOT, RELEASE_FILE } from './lib/paths.js';
import { requireApiOutputs } from './lib/stack.js';

export interface BuiltRelease {
  releaseId: string;
  env: string;
  frontendName: string;
  builtAt: string;
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
}

run(async () => {
  const { config, values } = parseCli(['release']);
  const now = new Date();
  const releaseId = values.release ?? releaseIdFor(now);
  assertReleaseId(releaseId);

  const api = await requireApiOutputs(config);
  // User pool ids are "<region>_<id>"; the app talks to Cognito in that region.
  const region = api.UserPoolId.split('_')[0];
  log(`Building ${config.frontendName} release ${releaseId} against ${api.ApiUrl}`);

  const vite = spawnSync(
    process.execPath,
    [path.join(PROJECT_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', 'app'],
    {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        VITE_API_URL: api.ApiUrl,
        VITE_USER_POOL_ID: api.UserPoolId,
        VITE_USER_POOL_CLIENT_ID: api.UserPoolClientId,
        VITE_REGION: region,
        VITE_RELEASE_ID: releaseId,
      },
    },
  );
  if (vite.status !== 0) throw new Error(`vite build failed (exit ${vite.status ?? vite.signal})`);

  const release: BuiltRelease = {
    releaseId,
    env: config.envName,
    frontendName: config.frontendName,
    builtAt: now.toISOString(),
    apiUrl: api.ApiUrl,
    userPoolId: api.UserPoolId,
    userPoolClientId: api.UserPoolClientId,
  };
  await writeFile(RELEASE_FILE, `${JSON.stringify(release, null, 2)}\n`);
  log(`Built release ${releaseId} into dist/ (details in release.json)`);
  process.stdout.write(`${releaseId}\n`);
});
