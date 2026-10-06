/**
 * Promotes the tested version: points `live` at the version `integration` serves (the one the
 * integration tests just passed on). The update is conditional on the alias's revision, so it
 * fails instead of overwriting a rollback that moved `live` meanwhile. Run deployment:sync next,
 * so the rollback system archives the version and records the deploy.
 *
 * Prints { from, to } as JSON.
 *
 * Usage: npx tsx scripts/promote.ts --env dev [--version <n>]   (--version asserts what integration serves)
 */
import { UpdateAliasCommand } from '@aws-sdk/client-lambda';
import { INTEGRATION_ALIAS, LIVE_ALIAS } from '../lib/config.js';
import { aliasVersion, lambda } from './lib/aws.js';
import { log, parseCli, run } from './lib/cli.js';

run(async () => {
  const { config, values } = parseCli(['version']);
  const fn = config.functionName;
  const [integration, live] = await Promise.all([aliasVersion(fn, INTEGRATION_ALIAS), aliasVersion(fn, LIVE_ALIAS)]);
  if (!integration || !live) throw new Error(`${fn} has no ${!integration ? INTEGRATION_ALIAS : LIVE_ALIAS} alias - deploy it first`);
  if (values.version && values.version !== integration.version) {
    throw new Error(`${fn}:${INTEGRATION_ALIAS} serves version ${integration.version}, not ${values.version} - nothing promoted`);
  }
  if (live.version === integration.version) {
    log(`${fn}:${LIVE_ALIAS} already serves version ${live.version}`);
  } else {
    await lambda.send(new UpdateAliasCommand({
      FunctionName: fn,
      Name: LIVE_ALIAS,
      FunctionVersion: integration.version,
      RevisionId: live.revisionId,
    }));
    log(`Promoted ${fn}:${LIVE_ALIAS}: version ${live.version} -> ${integration.version}`);
  }
  process.stdout.write(`${JSON.stringify({ from: live.version, to: integration.version })}\n`);
});
