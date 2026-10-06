/**
 * Prints the CDK context that keeps `live` on the version it serves, so `cdk deploy` only moves
 * `integration` to the new version:
 *
 *   -c liveLambdaVersion=<version>
 *
 * Prints nothing when the function doesn't exist yet (the first deploy goes straight to live).
 *
 * Usage: npx tsx scripts/live-context.ts --env dev
 */
import { LIVE_ALIAS } from '../lib/config.js';
import { aliasVersion } from './lib/aws.js';
import { log, parseCli, run } from './lib/cli.js';

run(async () => {
  const { config } = parseCli();
  const live = await aliasVersion(config.functionName, LIVE_ALIAS);
  if (!live) {
    log(`${config.functionName}:${LIVE_ALIAS} doesn't exist yet - the first deploy goes straight to live`);
    process.stdout.write('\n');
    return;
  }
  log(`Keeping ${config.functionName}:${LIVE_ALIAS} on version ${live.version}`);
  process.stdout.write(`-c liveLambdaVersion=${live.version}\n`);
});
