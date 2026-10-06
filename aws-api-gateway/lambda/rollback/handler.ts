/**
 * Subscribed to the API's alarm topic. When a 4xx/5xx alarm goes into ALARM, the
 * latest deployment is younger than ROLLBACK_WINDOW_MINUTES and the errors are not
 * the backend Lambda's fault, it re-imports the previous verified deployment's
 * OpenAPI spec (PutRestApi overwrite) and redeploys stage v1, then records the
 * rollback as a new deployment. The restored spec always invokes the latest Lambda.
 */
import { createHash } from 'node:crypto';
import type { SNSEvent } from 'aws-lambda';
import { APIGatewayClient, CreateDeploymentCommand, PutRestApiCommand } from '@aws-sdk/client-api-gateway';
import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { AddPermissionCommand, LambdaClient, ResourceConflictException } from '@aws-sdk/client-lambda';
import {
  claimRollback, DeploymentRecord, DeploymentTarget, getDeployment, getSpec, listDeployments, recordDeployment,
} from '../shared/deployments.js';
import {
  AlarmPair, isRestoreRequest, lambdaArnsFromSpec, lambdaFault, LambdaEvidence, ownAlarms, parseAlarms,
  planRollback, pointToAlias, RestoreRequest,
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
const ALARM_PAIRS: AlarmPair[] = JSON.parse(env('ALARM_PAIRS'));
const METRICS_NAMESPACE = env('METRICS_NAMESPACE');
const EVALUATION_MINUTES = Number(env('EVALUATION_MINUTES'));
const HANDLER_FUNCTION_ARN = env('HANDLER_FUNCTION_ARN');
const HANDLER_ALIAS_ARN = env('HANDLER_ALIAS_ARN');

const apigw = new APIGatewayClient({});
const cloudwatch = new CloudWatchClient({});
const lambda = new LambdaClient({});

const log = (msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...data }));

/** State of the paired Lambda alarm, and all vs. Lambda-produced errors over the evaluation window. */
async function lambdaEvidence(pair: AlarmPair, now = new Date()): Promise<LambdaEvidence> {
  const { MetricAlarms } = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: [pair.lambdaAlarm] }));
  const sum = (namespace: string, metricName: string, dimensions: Record<string, string>) => ({
    MetricStat: {
      Metric: {
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })),
      },
      Period: 60,
      Stat: 'Sum',
    },
  });
  const { MetricDataResults } = await cloudwatch.send(new GetMetricDataCommand({
    StartTime: new Date(now.getTime() - EVALUATION_MINUTES * 60_000),
    EndTime: now,
    MetricDataQueries: [
      { Id: 'api', ...sum('AWS/ApiGateway', pair.apiMetric, { ApiName: target.apiName, Stage: target.stageName }) },
      { Id: 'lambda', ...sum(METRICS_NAMESPACE, pair.lambdaMetric, {}) },
    ],
  }));
  const total = (id: string) => (MetricDataResults ?? [])
    .find((r) => r.Id === id)?.Values?.reduce((a, b) => a + b, 0) ?? 0;
  return {
    lambdaAlarmState: MetricAlarms?.[0]?.StateValue,
    apiErrors: total('api'),
    lambdaErrors: total('lambda'),
  };
}

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

/**
 * Re-imports a recorded deployment's spec (PutRestApi overwrite) and redeploys the stage.
 * Only the API config is restored: the backend integrations are pointed at the "live"
 * alias, so the API keeps invoking the latest Lambda code.
 */
async function redeploy(to: DeploymentRecord, description: string): Promise<string | undefined> {
  const spec = pointToAlias(JSON.parse(await getSpec(to.specBucket, to.specKey)), HANDLER_FUNCTION_ARN, HANDLER_ALIAS_ARN);
  for (const arn of lambdaArnsFromSpec(spec)) await ensureInvokePermission(arn);

  await apigw.send(new PutRestApiCommand({
    restApiId: target.restApiId,
    mode: 'overwrite',
    failOnWarnings: false,
    body: new TextEncoder().encode(JSON.stringify(spec)),
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

  // An API rollback keeps the latest Lambda, so it can't fix errors the Lambda produces.
  const faults: string[] = [];
  for (const alarm of alarms) {
    const pair = ALARM_PAIRS.find((p) => p.apiAlarm === alarm.alarmName);
    if (!pair) continue;
    const evidence = await lambdaEvidence(pair);
    const fault = lambdaFault(pair, evidence);
    log('lambda check', { alarm: alarm.alarmName, ...evidence, fault });
    if (fault) faults.push(fault);
  }
  if (faults.length === alarms.length) {
    const reason = `errors come from the backend Lambda (${faults.join('; ')}) - an API rollback would not fix them`;
    log('rollback skipped', { reason });
    return { action: 'skip', reason };
  }

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
    // same API config as the verified target, and the Lambda was not at fault, so it counts as verified too
    verifiedAt: to.verifiedAt,
    force: true,
  });
  log('rollback complete', { deploymentId, record });
  return { action: 'rolled-back', from: from.deployedAt, to: to.deployedAt, deploymentId };
};
