/**
 * Deployment history shared by the deploy scripts and the rollback Lambda.
 *
 * Every deployment of a stage gets:
 *   - its OpenAPI 3 export (with API Gateway extensions, so it can be re-imported)
 *     stored at s3://<apiName>-<account>-deployments/specs/<timestamp>/openapi.json
 *   - a record in the <apiName>-deployments DynamoDB table
 */
import { APIGatewayClient, GetExportCommand, GetStageCommand } from '@aws-sdk/client-api-gateway';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export type DeploymentSource = 'manual' | 'cicd' | 'rollback';

export interface DeploymentRecord {
  apiName: string;
  /** ISO 8601, table sort key */
  deployedAt: string;
  restApiId: string;
  stageName: string;
  /** API Gateway deployment id the stage pointed to */
  deploymentId: string;
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
}

export interface DeploymentTarget {
  apiName: string;
  restApiId: string;
  stageName: string;
  specBucket: string;
  table: string;
}

export interface RecordOptions {
  source: DeploymentSource;
  actor: string;
  commitSha?: string;
  runUrl?: string;
  description?: string;
  rolledBackFrom?: string;
  now?: Date;
}

const apigw = new APIGatewayClient({});
const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** 2026-10-06T12:30:05.123Z -> 20261006T123005Z */
export const compactTimestamp = (date: Date) =>
  date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export const specKey = (date: Date) => `specs/${compactTimestamp(date)}/openapi.json`;

export function buildRecord(
  target: DeploymentTarget,
  deploymentId: string,
  opts: RecordOptions,
): DeploymentRecord {
  const now = opts.now ?? new Date();
  return {
    apiName: target.apiName,
    deployedAt: now.toISOString(),
    restApiId: target.restApiId,
    stageName: target.stageName,
    deploymentId,
    specBucket: target.specBucket,
    specKey: specKey(now),
    source: opts.source,
    actor: opts.actor,
    commitSha: opts.commitSha,
    runUrl: opts.runUrl,
    description: opts.description,
    rolledBackFrom: opts.rolledBackFrom,
  };
}

export async function getStageDeploymentId(restApiId: string, stageName: string): Promise<string> {
  const stage = await apigw.send(new GetStageCommand({ restApiId, stageName }));
  if (!stage.deploymentId) throw new Error(`Stage ${stageName} of ${restApiId} has no deployment`);
  return stage.deploymentId;
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
 * Exports the stage's current spec to S3 and records the deployment.
 * Returns undefined (and records nothing) when the stage still points at the
 * same deployment as the latest record, i.e. nothing was actually deployed.
 */
export async function recordDeployment(
  target: DeploymentTarget,
  opts: RecordOptions & { force?: boolean },
): Promise<DeploymentRecord | undefined> {
  const deploymentId = await getStageDeploymentId(target.restApiId, target.stageName);
  const [latest] = await listDeployments(target.table, target.apiName, 1);
  if (!opts.force && latest?.deploymentId === deploymentId) return undefined;

  const record = buildRecord(target, deploymentId, opts);
  const spec = await exportStageSpec(target.restApiId, target.stageName);
  await s3.send(new PutObjectCommand({
    Bucket: target.specBucket,
    Key: record.specKey,
    Body: spec,
    ContentType: 'application/json',
    Metadata: { 'deployment-id': deploymentId, source: record.source },
  }));
  await ddb.send(new PutCommand({
    TableName: target.table,
    Item: record,
    ConditionExpression: 'attribute_not_exists(deployedAt)',
  }));
  return record;
}

export async function getSpec(bucket: string, key: string): Promise<string> {
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!Body) throw new Error(`Empty spec s3://${bucket}/${key}`);
  return Body.transformToString('utf8');
}

/**
 * Marks a deployment as being rolled back. Returns false if another rollback
 * already claimed it, so concurrent alarms (4xx + 5xx) roll back only once.
 */
export async function claimRollback(table: string, record: DeploymentRecord, now = new Date()) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { apiName: record.apiName, deployedAt: record.deployedAt },
      UpdateExpression: 'SET rolledBackAt = :now',
      ConditionExpression: 'attribute_exists(deployedAt) AND attribute_not_exists(rolledBackAt)',
      ExpressionAttributeValues: { ':now': now.toISOString() },
    }));
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}
