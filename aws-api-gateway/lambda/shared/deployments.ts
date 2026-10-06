/**
 * Deployment history shared by the deploy scripts and the rollback Lambda.
 *
 * Every deployment of a stage gets:
 *   - its OpenAPI 3 export (with API Gateway extensions, so it can be re-imported)
 *     stored at s3://<spec bucket>/<apiName>/<timestamp>/openapi.json
 *   - a record in the <apiName>-deployments DynamoDB table
 */
import { APIGatewayClient, GetExportCommand, GetStageCommand } from '@aws-sdk/client-api-gateway';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { GetAliasCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** rollback = automatic (alarm / failed tests), restore = a deployment chosen by hand */
export type DeploymentSource = 'manual' | 'cicd' | 'rollback' | 'restore';

export interface DeploymentRecord {
  apiName: string;
  /** ISO 8601, table sort key */
  deployedAt: string;
  restApiId: string;
  stageName: string;
  /** API Gateway deployment id the stage pointed to */
  deploymentId: string;
  /** Backend Lambda version the stage's `live` alias pointed to */
  lambdaVersion?: string;
  specBucket: string;
  specKey: string;
  source: DeploymentSource;
  actor: string;
  commitSha?: string;
  runUrl?: string;
  description?: string;
  /** For rollbacks: the deployedAt of the record that was rolled back */
  rolledBackFrom?: string;
  /** Set on a deployment once a rollback has claimed it (see claimRollback) */
  rolledBackAt?: string;
  /**
   * Set once integration tests passed against this deployment (CI: deployment:verify).
   * Rollbacks only ever restore verified deployments. A rollback record inherits the
   * verifiedAt of the deployment it restored, since it serves the same spec.
   */
  verifiedAt?: string;
  /** True only on the record the stage currently serves (the latest one). */
  current?: boolean;
  /**
   * Set once the deployment is replaced: true if it was replaced by a newer deployment,
   * false if an alarm rolled it back. Unset while it is current.
   */
  stable?: boolean;
  /** Seconds the deployment stayed live (until the next deployment). Only on stable deployments. */
  stableFor?: number;
}

export interface DeploymentTarget {
  apiName: string;
  restApiId: string;
  stageName: string;
  specBucket: string;
  table: string;
  /** Backend Lambda (name or ARN); its `live` alias version is recorded as lambdaVersion */
  handlerFunction?: string;
}

export interface RecordOptions {
  source: DeploymentSource;
  actor: string;
  commitSha?: string;
  runUrl?: string;
  description?: string;
  rolledBackFrom?: string;
  verifiedAt?: string;
  now?: Date;
}

const apigw = new APIGatewayClient({});
const lambda = new LambdaClient({});
const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** 2026-10-06T12:30:05.123Z -> 20261006T123005Z */
export const compactTimestamp = (date: Date) =>
  date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** <apiName>/<timestamp>/openapi.json - one "folder" per API, one per deployment inside it. */
export const specKey = (apiName: string, date: Date) => `${apiName}/${compactTimestamp(date)}/openapi.json`;

export function buildRecord(
  target: DeploymentTarget,
  deploymentId: string,
  opts: RecordOptions,
  lambdaVersion?: string,
): DeploymentRecord {
  const now = opts.now ?? new Date();
  return {
    apiName: target.apiName,
    deployedAt: now.toISOString(),
    restApiId: target.restApiId,
    stageName: target.stageName,
    deploymentId,
    lambdaVersion,
    specBucket: target.specBucket,
    specKey: specKey(target.apiName, now),
    source: opts.source,
    actor: opts.actor,
    commitSha: opts.commitSha,
    runUrl: opts.runUrl,
    description: opts.description,
    rolledBackFrom: opts.rolledBackFrom,
    verifiedAt: opts.verifiedAt,
    current: true,
  };
}

/**
 * The fields to set on the previous current deployment when `next` replaces it.
 * A deployment an alarm rollback claimed (rolledBackAt) is unstable; any other is
 * stable for the time between its deployment and the next one.
 */
export function retirement(previous: DeploymentRecord, next: DeploymentRecord):
  Pick<DeploymentRecord, 'current' | 'stable' | 'stableFor'> {
  if (previous.rolledBackAt) return { current: false, stable: false };
  const ms = new Date(next.deployedAt).getTime() - new Date(previous.deployedAt).getTime();
  return { current: false, stable: true, stableFor: Math.round(ms / 1000) };
}

export async function getStageDeploymentId(restApiId: string, stageName: string): Promise<string> {
  const stage = await apigw.send(new GetStageCommand({ restApiId, stageName }));
  if (!stage.deploymentId) throw new Error(`Stage ${stageName} of ${restApiId} has no deployment`);
  return stage.deploymentId;
}

/** Version a Lambda alias points to, or undefined if the alias doesn't exist. */
export async function getAliasVersion(functionName: string, alias: string): Promise<string | undefined> {
  try {
    const { FunctionVersion } = await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: alias }));
    return FunctionVersion;
  } catch (err) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') return undefined;
    throw err;
  }
}

/** OpenAPI 3 JSON of the stage, including x-amazon-apigateway-* extensions. */
export async function exportStageSpec(restApiId: string, stageName: string): Promise<string> {
  const { body } = await apigw.send(new GetExportCommand({
    restApiId,
    stageName,
    exportType: 'oas30',
    accepts: 'application/json',
    parameters: { extensions: 'apigateway' },
  }));
  if (!body) throw new Error(`Empty export for ${restApiId}/${stageName}`);
  return Buffer.from(body).toString('utf8');
}

export async function listDeployments(
  table: string,
  apiName: string,
  limit = 10,
): Promise<DeploymentRecord[]> {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'apiName = :api',
    ExpressionAttributeValues: { ':api': apiName },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return (Items ?? []) as DeploymentRecord[];
}

/**
 * Exports the stage's current spec to S3 and records the deployment as current.
 * The previous current deployment is retired in the same transaction (see retirement).
 * Returns undefined (and records nothing) when the stage still points at the
 * same deployment and Lambda version as the latest record, i.e. nothing was deployed.
 */
export async function recordDeployment(
  target: DeploymentTarget,
  opts: RecordOptions & { force?: boolean },
): Promise<DeploymentRecord | undefined> {
  const deploymentId = await getStageDeploymentId(target.restApiId, target.stageName);
  const lambdaVersion = target.handlerFunction ? await getAliasVersion(target.handlerFunction, 'live') : undefined;
  const [latest] = await listDeployments(target.table, target.apiName, 1);
  if (!opts.force && latest?.deploymentId === deploymentId && latest.lambdaVersion === lambdaVersion) return undefined;

  const record = buildRecord(target, deploymentId, opts, lambdaVersion);
  const spec = await exportStageSpec(target.restApiId, target.stageName);
  await s3.send(new PutObjectCommand({
    Bucket: target.specBucket,
    Key: record.specKey,
    Body: spec,
    ContentType: 'application/json',
    Metadata: { 'deployment-id': deploymentId, source: record.source },
  }));
  const put = {
    TableName: target.table,
    Item: record,
    ConditionExpression: 'attribute_not_exists(deployedAt)',
  };
  if (!latest) {
    await ddb.send(new PutCommand(put));
    return record;
  }
  const { stable, stableFor } = retirement(latest, record);
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: put },
      {
        Update: {
          TableName: target.table,
          Key: { apiName: latest.apiName, deployedAt: latest.deployedAt },
          // CURRENT is a DynamoDB reserved word
          UpdateExpression: stableFor === undefined
            ? 'SET #current = :false, #stable = :stable REMOVE #stableFor'
            : 'SET #current = :false, #stable = :stable, #stableFor = :stableFor',
          ConditionExpression: 'attribute_exists(deployedAt)',
          ExpressionAttributeNames: { '#current': 'current', '#stable': 'stable', '#stableFor': 'stableFor' },
          ExpressionAttributeValues: {
            ':false': false,
            ':stable': stable,
            ...(stableFor === undefined ? {} : { ':stableFor': stableFor }),
          },
        },
      },
    ],
  }));
  return record;
}

export async function getDeployment(
  table: string,
  apiName: string,
  deployedAt: string,
): Promise<DeploymentRecord | undefined> {
  const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: { apiName, deployedAt } }));
  return Item as DeploymentRecord | undefined;
}

/** Marks a deployment as having passed the integration tests. */
export async function markVerified(table: string, record: DeploymentRecord, now = new Date()) {
  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { apiName: record.apiName, deployedAt: record.deployedAt },
    UpdateExpression: 'SET verifiedAt = :now',
    ConditionExpression: 'attribute_exists(deployedAt)',
    ExpressionAttributeValues: { ':now': now.toISOString() },
  }));
}

export async function getSpec(bucket: string, key: string): Promise<string> {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!Body) throw new Error(`Empty spec s3://${bucket}/${key}`);
  return Body.transformToString('utf8');
}

/**
 * Marks a deployment as being rolled back, and as unstable (stableFor removed).
 * Returns false if another rollback already claimed it, so concurrent alarms
 * (4xx + 5xx) roll back only once.
 */
export async function claimRollback(table: string, record: DeploymentRecord, now = new Date()) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { apiName: record.apiName, deployedAt: record.deployedAt },
      UpdateExpression: 'SET rolledBackAt = :now, #stable = :false REMOVE #stableFor',
      ConditionExpression: 'attribute_exists(deployedAt) AND attribute_not_exists(rolledBackAt)',
      ExpressionAttributeNames: { '#stable': 'stable', '#stableFor': 'stableFor' },
      ExpressionAttributeValues: { ':now': now.toISOString(), ':false': false },
    }));
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}
