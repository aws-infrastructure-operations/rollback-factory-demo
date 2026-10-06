// The versions table: one VERSION#<n> item per archived version and one CURRENT item per function.
import {
  DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { CURRENT_SK, S, VERSION_PREFIX, isConditionFailure, versionSk } from './util.js';

export interface CurrentState {
  version: number;
  rollbackCount: number;
  lastRollbackAt?: string;
  updatedBy?: string;
  updatedAt?: string;
  stable: boolean;
  lastLatestRevertAt?: string;
}

export interface ArchivedVersion {
  version: number;
  codeSha256: string;
  s3Bucket: string;
  s3Key: string;
}

const archived = (item: Record<string, AttributeValue>): ArchivedVersion => ({
  version: Number(item.version.N),
  codeSha256: item.codeSha256.S!,
  s3Bucket: item.s3Bucket.S!,
  s3Key: item.s3Key.S!,
});

export async function getCurrent(ddb: DynamoDBClient, table: string, functionName: string): Promise<CurrentState | undefined> {
  const { Item } = await ddb.send(new GetItemCommand({
    TableName: table,
    Key: { functionName: S(functionName), sk: S(CURRENT_SK) },
    ConsistentRead: true,
  }));
  if (!Item) return undefined;
  return {
    version: Number(Item.version.N),
    rollbackCount: Number(Item.rollbackCount?.N ?? 0),
    lastRollbackAt: Item.lastRollbackAt?.S,
    updatedBy: Item.updatedBy?.S,
    updatedAt: Item.updatedAt?.S,
    stable: Item.stable?.BOOL === true,
    lastLatestRevertAt: Item.lastLatestRevertAt?.S,
  };
}

/** Every archived version item, oldest first (all attributes). */
export async function queryVersions(ddb: DynamoDBClient, table: string, functionName: string, { newestFirst = false } = {}) {
  const items: Record<string, AttributeValue>[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'functionName = :f AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':f': S(functionName), ':prefix': S(VERSION_PREFIX) },
      ScanIndexForward: !newestFirst,
      ConsistentRead: true,
      ExclusiveStartKey,
    }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export async function getVersionItem(ddb: DynamoDBClient, table: string, functionName: string, version: number) {
  const { Item } = await ddb.send(new GetItemCommand({
    TableName: table,
    Key: { functionName: S(functionName), sk: S(versionSk(version)) },
    ConsistentRead: true,
  }));
  return Item ? archived(Item) : undefined;
}

/**
 * The newest archived version older than `currentVersion` that a rollback may go back to: it was
 * live at some point (liveAt) and was never rolled back from. Versions published by a deploy whose
 * integration tests failed never went live, so they are never a target.
 */
export async function findRollbackTarget(ddb: DynamoDBClient, table: string, functionName: string, currentVersion: number) {
  const target = (await queryVersions(ddb, table, functionName, { newestFirst: true }))
    .find((item) => Number(item.version.N) < currentVersion && item.liveAt?.S && !item.rolledBackAt?.S);
  return target ? archived(target) : undefined;
}

/** Records when a version first went live (a deploy promoted it, or a rollback went back to it). */
export async function markLive(ddb: DynamoDBClient, table: string, functionName: string, version: number, at: string) {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: table,
      Key: { functionName: S(functionName), sk: S(versionSk(version)) },
      UpdateExpression: 'SET liveAt = if_not_exists(liveAt, :at)',
      ConditionExpression: 'attribute_exists(sk)',
      ExpressionAttributeValues: { ':at': S(at) },
    }));
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }
}

