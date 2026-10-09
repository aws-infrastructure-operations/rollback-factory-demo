/**
 * Rolls service-lambda back to the latest stable version after the integration tests failed on live
 * (deploy-test-rollback.yml). The version comes from the rollback service's archive in DynamoDB: the
 * newest one below the failed version that is marked stable and was never rolled back from. The
 * rollback service then points `live` at it, restores $LATEST from the version's zip in S3 and records
 * the rollback (the failed version is marked as rolled back from). `integration` is pointed at the
 * same version, so both aliases and $LATEST serve the stable build. Checks $LATEST runs its code.
 *
 * Prints { from, to, restoredFrom } as JSON.
 *
 * Usage: npx tsx scripts/rollback-to-stable.ts --env dev --failed-version <n> [--reason "..."]
 */
import { DynamoDBClient, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { INTEGRATION_ALIAS, LIVE_ALIAS } from '../lib/config.js';
import { aliasVersion, invokeJson, lambda } from './lib/aws.js';
import { log, parseCli, run } from './lib/cli.js';
import { latestStableVersion } from './lib/stable.js';

interface PointAliasResult { pointed?: boolean; reason?: string }

run(async () => {
  const { config, values } = parseCli(['failed-version', 'reason']);
  const fn = config.functionName;
  const failed = Number(values['failed-version']);
  if (!Number.isInteger(failed) || failed < 1) throw new Error('Pass --failed-version <n>: the version the tests failed on');

  const items: Record<string, AttributeValue>[] = [];
  const ddb = new DynamoDBClient({});
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: config.versionsTableName,
      KeyConditionExpression: 'functionName = :f AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':f': { S: fn }, ':prefix': { S: 'VERSION#' } },
      ConsistentRead: true,
      ExclusiveStartKey,
    }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const target = latestStableVersion(items, failed);
  if (!target) throw new Error(`${fn} has no stable version below ${failed} in ${config.versionsTableName} to roll back to`);
  log(`Latest stable version of ${fn}: ${target.version} (stable since ${target.stableAt ?? '?'}, ${target.description ?? 'no description'})`);

  const actor = process.env.GITHUB_ACTOR ? `github:${process.env.GITHUB_ACTOR}` : 'manual';
  const reason = values.reason ?? `integration tests failed on version ${failed}`;
  const point = async (aliasName: string) => {
    const current = await aliasVersion(fn, aliasName);
    if (current?.version === String(target.version)) {
      log(`${fn}:${aliasName} already serves version ${target.version}`);
      return;
    }
    const result = await invokeJson<PointAliasResult>(config.rollbackServiceFunctionName, {
      type: 'point-alias', functionName: fn, aliasName, version: target.version, actor, reason,
    });
    if (!result?.pointed) throw new Error(`Pointing ${fn}:${aliasName} at version ${target.version} failed: ${JSON.stringify(result)}`);
    log(`${fn}:${aliasName}: ${current?.version ?? '(none)'} -> ${target.version}`);
  };
  // live first: the rollback service moves it, restores $LATEST from S3 and records the rollback.
  // The failed tests may have set off the errors alarm, whose rollback can move live at the same time
  // (the alias update is conditional on its revision): read the alias again and retry.
  for (const aliasName of [LIVE_ALIAS, INTEGRATION_ALIAS]) {
    for (let attempt = 1; ; attempt++) {
      try {
        await point(aliasName);
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        log(`Attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}), retrying in 20s`);
        await new Promise((resolve) => setTimeout(resolve, 20_000));
      }
    }
  }

  // If live was already on the target (an alarm moved it), the rollback service didn't restore $LATEST here.
  const { CodeSha256 } = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fn }));
  if (CodeSha256 !== target.codeSha256) {
    throw new Error(`$LATEST of ${fn} runs ${CodeSha256}, not version ${target.version}'s ${target.codeSha256} `
      + `(s3://${target.s3Bucket}/${target.s3Key}): restore it with the "lambda rollback by version" workflow`);
  }
  process.stdout.write(`${JSON.stringify({ from: failed, to: target.version, restoredFrom: `s3://${target.s3Bucket}/${target.s3Key}` })}\n`);
});
