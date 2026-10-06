/**
 * Shows the archived versions of this environment's function and which alias serves each.
 *
 * Usage: npx tsx scripts/list-versions.ts --env dev [--limit 10]
 */
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { INTEGRATION_ALIAS, LIVE_ALIAS } from '../lib/config.js';
import { aliasVersion } from './lib/aws.js';
import { parseCli, run } from './lib/cli.js';

run(async () => {
  const { config, values } = parseCli(['limit']);
  const [live, integration] = await Promise.all([
    aliasVersion(config.functionName, LIVE_ALIAS), aliasVersion(config.functionName, INTEGRATION_ALIAS),
  ]);
  const { Items = [] } = await new DynamoDBClient({}).send(new QueryCommand({
    TableName: config.versionsTableName,
    KeyConditionExpression: 'functionName = :f AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':f': { S: config.functionName }, ':prefix': { S: 'VERSION#' } },
    ScanIndexForward: false,
    Limit: Number(values.limit ?? 10),
  }));
  console.table(Items.map((item) => {
    const version = item.version.N!;
    return {
      version,
      aliases: [version === live?.version && LIVE_ALIAS, version === integration?.version && INTEGRATION_ALIAS]
        .filter(Boolean).join(', '),
      description: item.description?.S ?? '',
      liveAt: item.liveAt?.S ?? '',
      stable: item.stable?.BOOL ? `yes (${item.stableAt?.S ?? ''})` : '',
      rolledBack: item.rolledBackAt?.S ? `${item.rolledBackBy?.S} (${item.stableFor?.S ?? ''})` : '',
    };
  }));
});
