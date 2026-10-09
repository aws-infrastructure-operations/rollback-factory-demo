import type { AttributeValue } from '@aws-sdk/client-dynamodb';

export interface StableVersion {
  version: number;
  codeSha256: string;
  s3Bucket: string;
  s3Key: string;
  stableAt?: string;
  description?: string;
}

/**
 * The newest archived version below `failedVersion` that is stable: the rollback service marked it
 * stable (it was live with all its alarms OK) and it was never rolled back from. Items are the
 * VERSION#<n> items of the rollback service's version archive, in any order.
 */
export function latestStableVersion(items: Record<string, AttributeValue>[], failedVersion: number): StableVersion | undefined {
  const item = items
    .filter((i) => Number(i.version?.N) < failedVersion && i.stable?.BOOL === true && !i.rolledBackAt?.S)
    .sort((a, b) => Number(b.version.N) - Number(a.version.N))[0];
  if (!item) return undefined;
  return {
    version: Number(item.version.N),
    codeSha256: item.codeSha256.S!,
    s3Bucket: item.s3Bucket.S!,
    s3Key: item.s3Key.S!,
    stableAt: item.stableAt?.S,
    description: item.description?.S,
  };
}
