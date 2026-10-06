/**
 * A manual deploy of one environment, end to end:
 *   live context -> cdk deploy --all (keeps the live release) -> release:build ->
 *   release:upload -> release:activate --wait
 *
 * Usage: npx tsx scripts/deploy.ts --env dev   (npm run deploy:dev)
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { log, parseCli, run } from './lib/cli.js';
import { PROJECT_ROOT } from './lib/paths.js';

/** Runs a node script of this project or a package bin; returns its stdout. */
function step(title: string, script: string, args: string[], { tsx = true } = {}) {
  log(`\n=== ${title}`);
  const command = tsx
    ? [path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(PROJECT_ROOT, script), ...args]
    : [path.join(PROJECT_ROOT, script), ...args];
  const result = spawnSync(process.execPath, command, {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? '');
    throw new Error(`${title} failed (exit ${result.status ?? result.signal})`);
  }
  return result.stdout.trim();
}

run(async () => {
  const { config } = parseCli();
  const env = ['--env', config.envName];

  const live = step('Live release', 'scripts/live-context.ts', env);
  const cdkOut = step('cdk deploy', path.join('node_modules', 'aws-cdk', 'bin', 'cdk'), [
    'deploy', '--all', '-c', `env=${config.envName}`, ...live.split(/\s+/).filter(Boolean), '--require-approval', 'never',
  ], { tsx: false });
  if (cdkOut) log(cdkOut);
  const releaseId = step('Build', 'scripts/build-release.ts', env);
  step('Upload', 'scripts/upload-release.ts', env);
  const activation = JSON.parse(step('Activate', 'scripts/activate-release.ts', [...env, '--release', releaseId, '--wait']));
  log(`\n${config.frontendName} serves release ${releaseId} at ${activation.siteUrl}`);
});
