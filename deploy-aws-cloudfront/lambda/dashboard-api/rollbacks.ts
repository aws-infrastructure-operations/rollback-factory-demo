// Every rollback the rollback service made, read-only, from the tables it records them in:
// - API: <project>-deployments-<env>, records with source "rollback" (alarm) or "restore" (by hand)
// - frontend: <project>-frontend-deployments-<env>, the same two sources
// - Lambda: <project>-lambda-archive-<env>, the version items marked rolledBackAt (the version left)
// For the environments CI deploys (dev, prod); a table that doesn't exist is skipped.
import { DynamoDBDocumentClient, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import type { RegisteredFunction } from './registered-functions.js';

export const ROLLBACK_ENVS = ['dev', 'prod'];
/** Newest records read per table: rollbacks are rare, so this goes back a long way. */
const RECORDS_PER_TABLE = 200;
export const MAX_ROLLBACKS = 100;

/** One rollback, as GET /api/rollbacks returns it (app/src/api.ts has the same shape). */
export interface RollbackEntry {
  kind: 'api' | 'lambda' | 'frontend';
  env: string;
  /** api-user-dev, service-lambda-dev, frontend-user-dev, ... */
  target: string;
  /** ISO 8601 */
  at: string;
  /** an alarm fired, or someone restored / pointed back by hand (the dashboard, a workflow) */
  trigger: 'alarm' | 'manual';
  /** the alarm's name, or who did it */
  by: string;
  /** what was replaced: a deployment id, a release id or vN */
  from?: string;
  /** what it went back to */
  to?: string;
  reason?: string;
}

interface DeploymentItem {
  deployedAt: string;
  source?: string;
  actor?: string;
  description?: string;
  rolledBackFrom?: string;
  // API
  deploymentId?: string;
  // frontend
  releaseId?: string;
  previousReleaseId?: string;
}

interface VersionItem {
  version: number;
  rolledBackAt?: string;
  rolledBackBy?: string;
  rolledBackTo?: number;
  rollbackReason?: string;
}

async function query<T>(dynamo: DynamoDBDocumentClient, input: QueryCommandInput): Promise<T[]> {
  try {
    const { Items = [] } = await dynamo.send(new QueryCommand(input));
    return Items as T[];
  } catch (err) {
    if ((err as Error).name === 'ResourceNotFoundException') return [];
    throw err;
  }
}

const newest = (table: string, key: string, value: string): QueryCommandInput => ({
  TableName: table,
  KeyConditionExpression: '#k = :v',
  ExpressionAttributeNames: { '#k': key },
  ExpressionAttributeValues: { ':v': value },
  ScanIndexForward: false,
  Limit: RECORDS_PER_TABLE,
});

/** "alarm:rollback-factory-demo-…-5xx-rate-dev" -> alarm; anything else was done by hand. */
const triggerOf = (actor: string | undefined): RollbackEntry['trigger'] => (actor?.startsWith('alarm') ? 'alarm' : 'manual');
const byOf = (actor: string | undefined) => actor?.replace(/^alarm:\s*/, '') || 'unknown';
/** "Rollback to 2026-10-07T12:00:00.000Z (abc123) after alarm: …" / "Restore to … (abc123): reason" -> abc123 */
const restoredDeploymentId = (description?: string) => /^(?:Rollback|Restore) to \S+ \(([^)]+)\)/.exec(description ?? '')?.[1];
/** The text after "after alarm:" or the reason given to a restore, if any. */
const reasonOf = (description?: string) => /(?:after alarm: |\): )(.+)$/.exec(description ?? '')?.[1];

async function apiRollbacks(dynamo: DynamoDBDocumentClient, project: string, env: string): Promise<RollbackEntry[]> {
  const target = `api-user-${env}`;
  const records = await query<DeploymentItem>(dynamo, newest(`${project}-deployments-${env}`, 'apiName', target));
  const byAt = new Map(records.map((r) => [r.deployedAt, r]));
  return records.filter((r) => r.source === 'rollback' || r.source === 'restore').map((r) => ({
    kind: 'api',
    env,
    target,
    at: r.deployedAt,
    trigger: r.source === 'rollback' ? 'alarm' : triggerOf(r.actor),
    by: byOf(r.actor),
    ...(r.rolledBackFrom && { from: byAt.get(r.rolledBackFrom)?.deploymentId ?? r.rolledBackFrom }),
    ...((restoredDeploymentId(r.description) ?? r.deploymentId) && { to: restoredDeploymentId(r.description) ?? r.deploymentId }),
    // an alarm rollback's description only names the alarm, already in `by`
    ...(r.source === 'restore' && reasonOf(r.description) && { reason: reasonOf(r.description) }),
  }));
}

async function frontendRollbacks(dynamo: DynamoDBDocumentClient, project: string, env: string): Promise<RollbackEntry[]> {
  const target = `frontend-user-${env}`;
  const records = await query<DeploymentItem>(dynamo, newest(`${project}-frontend-deployments-${env}`, 'frontendName', target));
  const byAt = new Map(records.map((r) => [r.deployedAt, r]));
  return records.filter((r) => r.source === 'rollback' || r.source === 'restore').map((r) => {
    const from = (r.rolledBackFrom && byAt.get(r.rolledBackFrom)?.releaseId) || r.previousReleaseId;
    return {
      kind: 'frontend',
      env,
      target,
      at: r.deployedAt,
      trigger: r.source === 'rollback' ? 'alarm' : triggerOf(r.actor),
      by: byOf(r.actor),
      ...(from && { from }),
      ...(r.releaseId && { to: r.releaseId }),
      ...(r.source === 'restore' && reasonOf(r.description) && { reason: reasonOf(r.description) }),
    };
  });
}

async function lambdaRollbacks(
  dynamo: DynamoDBDocumentClient, project: string, env: string, registered: RegisteredFunction[],
): Promise<RollbackEntry[]> {
  const table = `${project}-lambda-archive-${env}`;
  const perFunction = await Promise.all(registered.map(async ({ name }) => {
    const functionName = name.replaceAll('<env>', env);
    const versions = await query<VersionItem>(dynamo, {
      TableName: table,
      KeyConditionExpression: 'functionName = :fn AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':fn': functionName, ':prefix': 'VERSION#' },
      ScanIndexForward: false,
      Limit: RECORDS_PER_TABLE,
    });
    return versions.filter((v) => v.rolledBackAt).map((v): RollbackEntry => ({
      kind: 'lambda',
      env,
      target: functionName,
      at: v.rolledBackAt!,
      trigger: v.rollbackReason?.startsWith('alarm') ? 'alarm' : triggerOf(v.rolledBackBy),
      by: v.rollbackReason?.startsWith('alarm') ? v.rollbackReason.replace(/^alarm\s*/, '') : byOf(v.rolledBackBy),
      from: `v${v.version}`,
      // recorded since the rollback service writes it; older rollbacks only know the version left
      ...(v.rolledBackTo !== undefined && { to: `v${v.rolledBackTo}` }),
      ...(v.rollbackReason && !v.rollbackReason.startsWith('alarm') && { reason: v.rollbackReason }),
    }));
  }));
  return perFunction.flat();
}

/** The rollbacks of every environment and kind, newest first, at most MAX_ROLLBACKS. */
export async function listRollbacks(
  dynamo: DynamoDBDocumentClient,
  project: string,
  registered: RegisteredFunction[],
  envs = ROLLBACK_ENVS,
): Promise<RollbackEntry[]> {
  const all = await Promise.all(envs.flatMap((env) => [
    apiRollbacks(dynamo, project, env),
    frontendRollbacks(dynamo, project, env),
    lambdaRollbacks(dynamo, project, env, registered),
  ]));
  return all.flat().sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_ROLLBACKS);
}
