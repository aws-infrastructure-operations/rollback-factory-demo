// The recorded deployments of the APIs this project deploys (deploy-aws-api-gateway): every
// deployment of api-user-<env> has a record in <project>-deployments-<env> and its OpenAPI
// export in the deployments bucket. Restoring one goes through the rollback service, which
// re-imports that export and redeploys the stage (deploy-aws-api-gateway: deployment:restore).
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

/** The parts of a record (deploy-aws-api-gateway/lambda/shared/deployments.ts) the dashboard reads. */
interface ApiDeploymentRecord {
  apiName: string;
  deployedAt: string;
  restApiId: string;
  stageName: string;
  deploymentId: string;
  lambdaVersion?: string;
  specBucket: string;
  specKey: string;
  source: string;
  actor?: string;
  commitSha?: string;
  description?: string;
  rolledBackAt?: string;
  verifiedAt?: string;
  current?: boolean;
  stable?: boolean;
  stableForHumanReadable?: string;
}

/** One recorded deployment, as GET /api/api-gateways/<id> returns it (app/src/api.ts has the same shape). */
export interface RecordedApiDeployment {
  /** ISO 8601, the record's key: what a restore names */
  deployedAt: string;
  deploymentId: string;
  stageName: string;
  lambdaVersion?: string;
  /** s3://<bucket>/<apiName>/<timestamp>/openapi.json, the export a restore re-imports */
  spec: string;
  source: string;
  actor?: string;
  commit?: string;
  description?: string;
  current: boolean;
  verified: boolean;
  rolledBack: boolean;
  stableFor?: string;
}

export const MAX_RECORDED_DEPLOYMENTS = 25;

/** api-user-<env> is deployed by this project; any other API has no recorded deployments. */
const envOf = (apiName: string) => /^api-user-([a-z0-9]+)$/.exec(apiName)?.[1];

export function deploymentsTableFor(apiName: string, project: string): string | undefined {
  const env = envOf(apiName);
  return env && `${project}-deployments-${env}`;
}

export function rollbackServiceFor(apiName: string, project: string): string | undefined {
  const env = envOf(apiName);
  return env && `${project}-rollback-service-${env}`;
}

/** deployedAt values are toISOString() output. */
export const isDeployedAt = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value);

const view = (r: ApiDeploymentRecord): RecordedApiDeployment => ({
  deployedAt: r.deployedAt,
  deploymentId: r.deploymentId,
  stageName: r.stageName,
  ...(r.lambdaVersion && { lambdaVersion: r.lambdaVersion }),
  spec: `s3://${r.specBucket}/${r.specKey}`,
  source: r.source,
  ...(r.actor && { actor: r.actor }),
  ...(r.commitSha && { commit: r.commitSha }),
  ...(r.description && { description: r.description }),
  current: r.current === true,
  verified: r.verifiedAt !== undefined,
  rolledBack: r.rolledBackAt !== undefined || r.stable === false,
  ...(r.stableForHumanReadable && { stableFor: r.stableForHumanReadable }),
});

/** Undefined when the table doesn't exist (e.g. that environment isn't deployed). */
async function query(dynamo: DynamoDBDocumentClient, table: string, apiName: string, deployedAt?: string) {
  try {
    const { Items = [] } = await dynamo.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: deployedAt ? 'apiName = :api AND deployedAt = :at' : 'apiName = :api',
      ExpressionAttributeValues: { ':api': apiName, ...(deployedAt && { ':at': deployedAt }) },
      ScanIndexForward: false,
      Limit: MAX_RECORDED_DEPLOYMENTS,
    }));
    return Items as ApiDeploymentRecord[];
  } catch (err) {
    if ((err as Error).name === 'ResourceNotFoundException') return undefined;
    throw err;
  }
}

/**
 * The API's recorded deployments, newest first. Undefined for APIs this project doesn't deploy.
 * A recreated API starts a new history under the same name: only the records of this id count.
 */
export async function listRecordedDeployments(
  dynamo: DynamoDBDocumentClient,
  project: string,
  apiName: string,
  restApiId: string,
): Promise<RecordedApiDeployment[] | undefined> {
  const table = deploymentsTableFor(apiName, project);
  const records = table ? await query(dynamo, table, apiName) : undefined;
  return records?.filter((r) => r.restApiId === restApiId).map(view);
}

export type RestoreResult =
  | { ok: true; result: unknown }
  | { ok: false; status: 400 | 404 | 409 | 502; message: string };

/**
 * Restores the API's stage to the deployment recorded at `deployedAt`: the rollback service
 * re-imports its spec from S3, redeploys the stage and records a "restore" (not verified until
 * the integration tests pass again). Synchronous, so the page can show the outcome.
 */
export async function restoreRecordedDeployment(
  dynamo: DynamoDBDocumentClient,
  lambda: LambdaClient,
  project: string,
  api: { id: string; name: string },
  req: { deployedAt: string; reason?: string },
): Promise<RestoreResult> {
  const table = deploymentsTableFor(api.name, project);
  const service = rollbackServiceFor(api.name, project);
  if (!table || !service) return { ok: false, status: 400, message: `${api.name} isn't deployed by this project: nothing to restore` };

  const [record] = (await query(dynamo, table, api.name, req.deployedAt)) ?? [];
  if (!record || record.restApiId !== api.id) {
    return { ok: false, status: 404, message: `No deployment of ${api.name} recorded at ${req.deployedAt}` };
  }
  if (record.current) return { ok: false, status: 409, message: `${api.name} already serves the deployment recorded at ${req.deployedAt}` };

  const res = await lambda.send(new InvokeCommand({
    FunctionName: service,
    Payload: new TextEncoder().encode(JSON.stringify({
      type: 'restore', manager: 'apigateway', deployedAt: record.deployedAt, actor: 'dashboard', reason: req.reason,
    })),
  }));
  const payload = res.Payload ? new TextDecoder().decode(res.Payload) : '';
  if (res.FunctionError) {
    console.error(`Restore of ${api.name} to ${record.deployedAt} failed`, payload);
    return { ok: false, status: 502, message: `The rollback service could not restore ${api.name}` };
  }
  return { ok: true, result: payload ? JSON.parse(payload) : undefined };
}
