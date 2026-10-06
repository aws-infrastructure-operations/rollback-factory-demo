import type { AttributeValue } from '@aws-sdk/client-dynamodb';

export const CURRENT_SK = 'CURRENT';
export const VERSION_PREFIX = 'VERSION#';

/** VERSION#0000000003: zero-padded so versions sort numerically. */
export const versionSk = (version: number) => `${VERSION_PREFIX}${String(version).padStart(10, '0')}`;
/** <fn>/<fn>-<version>.zip in the artifacts bucket. */
export const s3Key = (functionName: string, version: number) => `${functionName}/${functionName}-${version}.zip`;

export const S = (value: unknown): AttributeValue => ({ S: String(value ?? '') });
export const N = (value: number): AttributeValue => ({ N: String(value) });
export const BOOL = (value: boolean): AttributeValue => ({ BOOL: value });

/** e.g. 93784 -> "1d 2h 3m"; under a minute -> "45s". */
export function formatDuration(seconds: number): string {
  const parts: string[] = [];
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.length > 0 ? parts.join(' ') : `${seconds}s`;
}

export interface SkipResult {
  rolledBack: false;
  reason: string;
}

export function skip(reason: string): SkipResult {
  console.log(`Skipping: ${reason}`);
  return { rolledBack: false, reason };
}

export const isConditionFailure = (err: unknown) =>
  err instanceof Error && err.name === 'ConditionalCheckFailedException';
