/**
 * Invokes the rollback function's sync for this environment's function: archives every new
 * version (S3 + DynamoDB) and records a `live` move made outside the rollback system (a promotion)
 * as a deploy. Fails if the sync failed.
 *
 * Usage: npx tsx scripts/sync.ts --env dev
 */
import { invokeJson } from './lib/aws.js';
import { log, parseCli, run } from './lib/cli.js';

run(async () => {
  const { config } = parseCli();
  const results = await invokeJson<Array<{ synced?: boolean }>>(
    config.rollbackFunctionName, { type: 'sync', functionName: config.functionName },
  );
  process.stdout.write(`${JSON.stringify(results)}\n`);
  if (!Array.isArray(results) || results.some((r) => r.synced !== true)) {
    throw new Error(`Sync of ${config.functionName} failed: ${JSON.stringify(results)}`);
  }
  log(`Synced ${config.functionName}`);
});
