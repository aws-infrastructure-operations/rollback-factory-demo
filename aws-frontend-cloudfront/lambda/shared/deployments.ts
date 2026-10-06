/**
 * Deployment history shared by the release scripts and the rollback Lambda.
 *
 * Every time the distribution starts serving a release (activation, restore or rollback) a
 * record goes into rollback-factory-demo-frontend-deployments-<env>, keyed by frontendName +
 * deployedAt. The record model follows the API's (aws-api-gateway/lambda/shared/deployments.ts).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

/** rollback = automatic (alarm), restore = a release chosen by hand */
export type DeploymentSource = 'manual' | 'cicd' | 'rollback' | 'restore';

export interface DeploymentRecord {
  frontendName: string;
  /** ISO 8601, table sort key */
  deployedAt: string;
  releaseId: string;
  /** Origin path the distribution was switched to, /releases/<releaseId> */
  originPath: string;
  distributionId: string;
  /** Build manifest of the release in the deployments bucket */
  manifestKey: string;
  /** The /* invalidation created with the switch */
  invalidationId?: string;
  /** The release the distribution served before this one */
  previousReleaseId?: string;
  source: DeploymentSource;
  actor: string;
  commit?: string;
  runUrl?: string;
  description?: string;
  /** For rollbacks: the deployedAt of the record that was rolled back */
  rolledBackFrom?: string;
  /** Set on a deployment once a rollback has claimed it (see claimRollback) */
  rolledBackAt?: string;
  /**
   * Set once the integration tests passed against this deployment (deployment:verify).
   * Rollbacks only go back to verified deployments. A rollback record inherits the
   * verifiedAt of the deployment it went back to, since it serves the same release.
   */
  verifiedAt?: string;
  /** True only on the record the distribution currently serves (the latest one). */
  current?: boolean;
  /**
   * Set once the deployment is replaced: true if a newer deployment replaced it,
   * false if an alarm rolled it back. Unset while it is current.
   */
  stable?: boolean;
  /** Seconds the deployment stayed live (until the next deployment). Only on stable deployments. */
  stableFor?: number;
  /** stableFor as text, e.g. "2 hours 30 minutes" (see formatDuration). */
  stableForHumanReadable?: string;
}

export type NewDeployment = Omit<DeploymentRecord,
  'deployedAt' | 'current' | 'stable' | 'stableFor' | 'stableForHumanReadable' | 'rolledBackAt'>;

/**
 * Human-readable duration in days, hours and minutes; seconds only below a minute.
 * 9006 -> "2 hours 30 minutes", 90061 -> "1 day 1 hour 1 minute", 45 -> "45 seconds"
 * (same as the API's, which lives in another package)
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} ${total === 1 ? 'second' : 'seconds'}`;
  const parts: [number, string][] = [
    [Math.floor(total / 86_400), 'day'],
    [Math.floor((total % 86_400) / 3600), 'hour'],
    [Math.floor((total % 3600) / 60), 'minute'],
  ];
  return parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`).join(' ');
}

/**
 * The fields to set on the previous current deployment when `next` replaces it.
 * A deployment an alarm rollback claimed (rolledBackAt) is unstable; any other is
 * stable for the time between its deployment and the next one.
 */
export function retirement(previous: DeploymentRecord, next: Pick<DeploymentRecord, 'deployedAt'>):
  Pick<DeploymentRecord, 'current' | 'stable' | 'stableFor' | 'stableForHumanReadable'> {
  if (previous.rolledBackAt) return { current: false, stable: false };
  const ms = new Date(next.deployedAt).getTime() - new Date(previous.deployedAt).getTime();
  const stableFor = Math.round(ms / 1000);
  return { current: false, stable: true, stableFor, stableForHumanReadable: formatDuration(stableFor) };
}

export interface DeploymentStoreOptions {
  table: string;
  frontendName: string;
  /** The table's region; the rollback Lambda runs in us-east-1, the table in the main region. */
  region?: string;
  /** For tests. */
  client?: DynamoDBDocumentClient;
}

export type DeploymentStore = ReturnType<typeof createDeploymentStore>;

export function createDeploymentStore({ table, frontendName, region, client }: DeploymentStoreOptions) {
  const ddb = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const key = (record: Pick<DeploymentRecord, 'deployedAt'>) => ({ frontendName, deployedAt: record.deployedAt });

  const list = async (limit = 10): Promise<DeploymentRecord[]> => {
    const { Items } = await ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'frontendName = :name',
      ExpressionAttributeValues: { ':name': frontendName },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return (Items ?? []) as DeploymentRecord[];
  };

  return {
    table,
    list,

    async latest(): Promise<DeploymentRecord | undefined> {
      return (await list(1))[0];
    },

    /**
     * Records `deployment` as current and retires the previous current record in the same
     * transaction (see retirement). Returns undefined (and records nothing) when the latest
     * record already has this release, i.e. the distribution didn't change, unless force.
     */
    async record(deployment: NewDeployment, { now = new Date(), force = false } = {}):
      Promise<DeploymentRecord | undefined> {
      const latest = (await list(1))[0];
      if (!force && latest?.releaseId === deployment.releaseId) return undefined;

      const record: DeploymentRecord = { ...deployment, frontendName, deployedAt: now.toISOString(), current: true };
      const put = { TableName: table, Item: record, ConditionExpression: 'attribute_not_exists(deployedAt)' };
      if (!latest) {
        await ddb.send(new PutCommand(put));
        return record;
      }
      const { stable, stableFor, stableForHumanReadable } = retirement(latest, record);
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          { Put: put },
          {
            Update: {
              TableName: table,
              Key: key(latest),
              // CURRENT is a DynamoDB reserved word
              UpdateExpression: stableFor === undefined
                ? 'SET #current = :false, #stable = :stable REMOVE #stableFor, #stableForHumanReadable'
                : 'SET #current = :false, #stable = :stable, #stableFor = :stableFor, '
                  + '#stableForHumanReadable = :stableForHumanReadable',
              ConditionExpression: 'attribute_exists(deployedAt)',
              ExpressionAttributeNames: {
                '#current': 'current',
                '#stable': 'stable',
                '#stableFor': 'stableFor',
                '#stableForHumanReadable': 'stableForHumanReadable',
              },
              ExpressionAttributeValues: {
                ':false': false,
                ':stable': stable,
                ...(stableFor === undefined ? {} : { ':stableFor': stableFor, ':stableForHumanReadable': stableForHumanReadable }),
              },
            },
          },
        ],
      }));
      return record;
    },

    /** Marks a deployment as having passed the integration tests. */
    async markVerified(record: DeploymentRecord, now = new Date()) {
      await ddb.send(new UpdateCommand({
        TableName: table,
        Key: key(record),
        UpdateExpression: 'SET verifiedAt = :now',
        ConditionExpression: 'attribute_exists(deployedAt)',
        ExpressionAttributeValues: { ':now': now.toISOString() },
      }));
    },

    /**
     * Marks a deployment as being rolled back, and as unstable (stableFor removed).
     * Returns false if another rollback already claimed it, so concurrent alarms
     * (4xx + 5xx) roll back only once.
     */
    async claimRollback(record: DeploymentRecord, now = new Date()) {
      try {
        await ddb.send(new UpdateCommand({
          TableName: table,
          Key: key(record),
          UpdateExpression: 'SET rolledBackAt = :now, #stable = :false REMOVE #stableFor, #stableForHumanReadable',
          ConditionExpression: 'attribute_exists(deployedAt) AND attribute_not_exists(rolledBackAt)',
          ExpressionAttributeNames: { '#stable': 'stable', '#stableFor': 'stableFor', '#stableForHumanReadable': 'stableForHumanReadable' },
          ExpressionAttributeValues: { ':now': now.toISOString(), ':false': false },
        }));
        return true;
      } catch (err) {
        if (err instanceof Error && err.name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
  };
}
