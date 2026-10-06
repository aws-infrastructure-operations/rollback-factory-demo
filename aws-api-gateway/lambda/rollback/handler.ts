/**
 * Subscribed to the API's alarm topic. When a 4xx/5xx alarm goes into ALARM and
 * the latest deployment is younger than ROLLBACK_WINDOW_MINUTES, it re-imports
 * the previous deployment's OpenAPI spec (PutRestApi overwrite) and redeploys
 * stage v1, then records the rollback as a new deployment.
 */
import { createHash } from 'node:crypto';
import type { SNSEvent } from 'aws-lambda';
import { APIGatewayClient, CreateDeploymentCommand, PutRestApiCommand } from '@aws-sdk/client-api-gateway';
import { AddPermissionCommand, LambdaClient, ResourceConflictException } from '@aws-sdk/client-lambda';
import {
  claimRollback, DeploymentRecord, DeploymentTarget, getDeployment, getSpec, listDeployments, recordDeployment,
} from '../shared/deployments.js';
import {
  isRestoreRequest, lambdaArnsFromSpec, ownAlarms, parseAlarms, planRollback, RestoreRequest,
} from './plan.js';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
};

const target: DeploymentTarget = {
  apiName: env('API_NAME'),
  restApiId: env('REST_API_ID'),
  stageName: env('STAGE_NAME'),
  specBucket: env('SPEC_BUCKET'),
  table: env('DEPLOYMENTS_TABLE'),
};
const WINDOW_MINUTES = Number(env('ROLLBACK_WINDOW_MINUTES'));
const ALARM_NAMES = env('ALARM_NAMES').split(',');

const apigw = new APIGatewayClient({});
const lambda = new LambdaClient({});

const log = (msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...data }));

/**
 * The old spec may point at a Lambda version whose API Gateway invoke permission
 * was removed by a later CDK deploy, so re-grant it (idempotent).
 */
async function ensureInvokePermission(functionArn: string) {
  // arn:aws:lambda:<region>:<account>:function:<name>[:<qualifier>]
  const [, partition, , region, account] = functionArn.split(':');
  const sourceArn = `arn:${partition}:execute-api:${region}:${account}:${target.restApiId}/*/*/*`;
  const statementId = `apigw-rollback-${createHash('sha256').update(sourceArn).digest('hex').slice(0, 16)}`;
  try {
    await lambda.send(new AddPermissionCommand({
      FunctionName: functionArn,
      StatementId: statementId,
      Action: 'lambda:InvokeFunction',
      Principal: 'apigateway.amazonaws.com',
      SourceArn: sourceArn,
    }));
    log('granted invoke permission', { functionArn });
  } catch (err) {
    if (!(err instanceof ResourceConflictException)) throw err;
  }
}

/** Re-imports a recorded deployment's spec (PutRestApi overwrite) and redeploys the stage. */
async function redeploy(to: DeploymentRecord, description: string): Promise<string | undefined> {
  const spec = await getSpec(to.specBucket, to.specKey);
  for (const arn of lambdaArnsFromSpec(JSON.parse(spec))) await ensureInvokePermission(arn);

  await apigw.send(new PutRestApiCommand({
    restApiId: target.restApiId,
    mode: 'overwrite',
    failOnWarnings: false,
    body: new TextEncoder().encode(spec),
  }));
  const deployment = await apigw.send(new CreateDeploymentCommand({
    restApiId: target.restApiId,
    stageName: target.stageName,
    description: description.slice(0, 1024),
  }));
  return deployment.id;
}

/** Manual restore of a chosen deployment (scripts/restore-deployment.ts). No window or verification checks. */
async function restore({ restore: req }: RestoreRequest) {
  const to = await getDeployment(target.table, target.apiName, req.deployedAt);
  if (!to) throw new Error(`No deployment of ${target.apiName} recorded at ${req.deployedAt}`);

  const description = `Restore to ${to.deployedAt} (${to.deploymentId})${req.reason ? `: ${req.reason}` : ''}`;
  log('restoring', { to: to.deployedAt, toDeployment: to.deploymentId, spec: to.specKey, actor: req.actor });
  const deploymentId = await redeploy(to, description);

  // Not verified: the restored deployment has to pass the integration tests again.
  const record = await recordDeployment(target, {
    source: 'restore',
    actor: req.actor ?? 'manual',
    commitSha: to.commitSha,
    description,
    force: true,
  });
  log('restore complete', { deploymentId, record });
  return { action: 'restored', to: to.deployedAt, deploymentId, deployedAt: record?.deployedAt };
}

export const handler = async (event: SNSEvent | RestoreRequest) => {
  if (isRestoreRequest(event)) return restore(event);

  const alarms = ownAlarms(parseAlarms(event), ALARM_NAMES);
  if (alarms.length === 0) {
    log('no ALARM transition of this API in event, nothing to do');
    return { action: 'skip', reason: 'no ALARM transition of this API' };
  }
  const alarmNames = alarms.map((a) => a.alarmName).join(', ');
  log('alarm received', { alarms });

  const plan = planRollback(await listDeployments(target.table, target.apiName, 20), new Date(), WINDOW_MINUTES);
  if (plan.action === 'skip') {
    log('rollback skipped', { reason: plan.reason });
    return plan;
  }
  const { from, to } = plan;

  if (!(await claimRollback(target.table, from))) {
    log('rollback skipped', { reason: 'already claimed by a concurrent invocation' });
    return { action: 'skip', reason: 'already claimed' };
  }
  log('rolling back', { from: from.deployedAt, fromDeployment: from.deploymentId, to: to.deployedAt, spec: to.specKey });

  const description = `Rollback to ${to.deployedAt} (${to.deploymentId}) after alarm: ${alarmNames}`;
  const deploymentId = await redeploy(to, description);

  const record = await recordDeployment(target, {
    source: 'rollback',
    actor: `alarm:${alarmNames}`,
    commitSha: to.commitSha,
    description,
    rolledBackFrom: from.deployedAt,
    // same spec as the verified target, so it counts as verified too
    verifiedAt: to.verifiedAt,
    force: true,
  });
  log('rollback complete', { deploymentId, record });
  return { action: 'rolled-back', from: from.deployedAt, to: to.deployedAt, deploymentId };
};
