// The rollback service's version archive of a registered function (rollback-service: the
// <project>-lambda-archive-<env> table): which published versions have their zip in S3, and which
// the scheduled check marked stable. The live alias may only be pointed (redeployed) at stable ones.
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

/** One archived version, as GET /api/lambda-functions/<name> returns it on its version (app/src/api.ts too). */
export interface ArchivedVersionInfo {
  /** s3://<bucket>/<fn>/<fn>-<version>.zip: what redeploying it restores $LATEST from */
  s3Uri: string;
  /** live with all its alarms OK for long enough; false once rolled back from */
  stable: boolean;
  stableAt?: string;
  liveAt?: string;
  rolledBackAt?: string;
}

interface VersionItem {
  version: number;
  s3Bucket?: string;
  s3Key?: string;
  stable?: boolean;
  stableAt?: string;
  liveAt?: string;
  rolledBackAt?: string;
}

/**
 * The archived versions of `functionName` by version number. Empty when the environment's rollback
 * service (its table) isn't deployed.
 */
export async function listArchivedVersions(
  dynamo: DynamoDBDocumentClient,
  table: string,
  functionName: string,
): Promise<Map<string, ArchivedVersionInfo>> {
  const items: VersionItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  try {
    do {
      const page = await dynamo.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'functionName = :fn AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':fn': functionName, ':prefix': 'VERSION#' },
        ExclusiveStartKey,
      }));
      items.push(...((page.Items ?? []) as VersionItem[]));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  } catch (err) {
    if ((err as Error).name === 'ResourceNotFoundException') return new Map();
    throw err;
  }
  return new Map(items.filter((i) => i.s3Bucket && i.s3Key).map((i) => [String(i.version), {
    s3Uri: `s3://${i.s3Bucket}/${i.s3Key}`,
    stable: i.stable === true,
    ...(i.stableAt && { stableAt: i.stableAt }),
    ...(i.liveAt && { liveAt: i.liveAt }),
    ...(i.rolledBackAt && { rolledBackAt: i.rolledBackAt }),
  }]));
}
