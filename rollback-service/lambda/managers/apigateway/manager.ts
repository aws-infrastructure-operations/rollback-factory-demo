/**
 * API Gateway rollback manager. For an api-user rate alarm in ALARM: if the latest deployment is
 * younger than the rollback window and the errors are not the backend Lambda's fault, it re-imports
 * the previous verified deployment's OpenAPI spec (PutRestApi overwrite), redeploys stage v1 and
 * records the rollback. The restored spec always invokes the latest promoted Lambda (alias `live`).
 * Also restores a chosen deployment on request (deploy-aws-api-gateway: deployment:restore).
 *
 * Everything about the target comes from the API stack's RollbackTarget output (see targets.ts).
 */
import { createHash } from 'node:crypto';
import { APIGatewayClient, CreateDeploymentCommand, PutRestApiCommand } from '@aws-sdk/client-api-gateway';
import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { AddPermissionCommand, LambdaClient, ResourceConflictException } from '@aws-sdk/client-lambda';
import {
  claimRollback, DeploymentRecord, DeploymentTarget, getDeployment, getSpec, listDeployments, recordDeployment,
} from './deployments.js';
import {
  AlarmNotification, AlarmPair, lambdaArnsFromSpec, lambdaFault, LambdaEvidence, planRollback, pointToAlias,
} from './plan.js';

/** The API stack's RollbackTarget output. */
export interface ApiRollbackTarget {
  apiName: string;
  restApiId: string;
  stageName: string;
  specBucket: string;
  table: string;
  handlerFunctionArn: string;
  /** The rate alarms that trigger a rollback; others (paired Lambda alarms) only notify. */
  alarmNames: string[];
  alarmPairs: AlarmPair[];
  metricsNamespace: string;
  rollbackWindowMinutes: number;
  evaluationMinutes: number;
}

export interface RestoreRequest {
  deployedAt: string;
  reason?: string;
  actor?: string;
}

const apigw = new APIGatewayClient({});
const cloudwatch = new CloudWatchClient({});
const lambda = new LambdaClient({});

const log = (msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ manager: 'apigateway', msg, ...data }));

const deploymentTarget = (t: ApiRollbackTarget): DeploymentTarget => ({
  apiName: t.apiName,
  restApiId: t.restApiId,
  stageName: t.stageName,
  specBucket: t.specBucket,
  table: t.table,
  handlerFunction: t.handlerFunctionArn,
});

/** State of the paired Lambda alarm, and all vs. Lambda-produced errors over the evaluation window. */
async function lambdaEvidence(target: ApiRollbackTarget, pair: AlarmPair, now = new Date()): Promise<LambdaEvidence> {
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
    StartTime: new Date(now.getTime() - target.evaluationMinutes * 60_000),
    EndTime: now,
    MetricDataQueries: [
      { Id: 'api', ...sum('AWS/ApiGateway', pair.apiMetric, { ApiName: target.apiName, Stage: target.stageName }) },
      { Id: 'lambda', ...sum(target.metricsNamespace, pair.lambdaMetric, {}) },
    ],
  }));
  const total = (id: string) => (MetricDataResults ?? []).find((r) => r.Id === id)?.Values?.reduce((a, b) => a + b, 0) ?? 0;
  return { lambdaAlarmState: MetricAlarms?.[0]?.StateValue, apiErrors: total('api'), lambdaErrors: total('lambda') };
}

/**
 * The old spec may point at a Lambda version whose API Gateway invoke permission was removed by a
 * later CDK deploy, so re-grant it (idempotent).
 */
async function ensureInvokePermission(target: ApiRollbackTarget, functionArn: string) {
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
 * Re-imports a recorded deployment's spec (PutRestApi overwrite) and redeploys the stage. Only the
 * API config is restored: the backend integrations are pointed at the stage's alias (v1: live), so
 * the API keeps invoking the latest promoted Lambda code.
 */
async function redeploy(target: ApiRollbackTarget, to: DeploymentRecord, description: string) {
  const stageAliasArn = `${target.handlerFunctionArn}:\${stageVariables.lambdaAlias}`;
  const spec = pointToAlias(JSON.parse(await getSpec(to.specBucket, to.specKey)), target.handlerFunctionArn, stageAliasArn);
  // the stage aliases' invoke permissions are managed by the stack
  for (const arn of lambdaArnsFromSpec(spec).filter((a) => !a.includes('${'))) await ensureInvokePermission(target, arn);

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

/** Manual restore of a chosen deployment. No window or verification checks. */
export async function restore(target: ApiRollbackTarget, req: RestoreRequest) {
  const dt = deploymentTarget(target);
  const to = await getDeployment(dt.table, dt.apiName, req.deployedAt);
  if (!to) throw new Error(`No deployment of ${dt.apiName} recorded at ${req.deployedAt}`);

  const description = `Restore to ${to.deployedAt} (${to.deploymentId})${req.reason ? `: ${req.reason}` : ''}`;
  log('restoring', { to: to.deployedAt, toDeployment: to.deploymentId, spec: to.specKey, actor: req.actor });
  const deploymentId = await redeploy(target, to, description);

  // Not verified: the restored deployment has to pass the integration tests again.
  const record = await recordDeployment(dt, {
    source: 'restore',
    actor: req.actor ?? 'manual',
    commitSha: to.commitSha,
    description,
    force: true,
  });
  log('restore complete', { deploymentId, record });
  return { action: 'restored', to: to.deployedAt, deploymentId, deployedAt: record?.deployedAt };
}

/** Handles one ALARM notification of an apigateway-typed alarm. */
export async function handleAlarm(target: ApiRollbackTarget, alarm: AlarmNotification) {
  if (alarm.newState !== 'ALARM') return { action: 'skip', reason: `state is ${alarm.newState}, not ALARM` };
  if (!target.alarmNames.includes(alarm.alarmName)) {
    // e.g. the paired Lambda alarms: they notify (and block rollbacks) but never trigger one
    return { action: 'skip', reason: `${alarm.alarmName} doesn't trigger a rollback of ${target.apiName}` };
  }
  log('alarm received', { alarm });
  const dt = deploymentTarget(target);

  const plan = planRollback(await listDeployments(dt.table, dt.apiName, 20), new Date(), target.rollbackWindowMinutes);
  if (plan.action === 'skip') {
    log('rollback skipped', { reason: plan.reason });
    return plan;
  }
  const { from, to } = plan;

  // An API rollback keeps the latest Lambda, so it can't fix errors the Lambda produces.
  const pair = target.alarmPairs.find((p) => p.apiAlarm === alarm.alarmName);
  if (pair) {
    const evidence = await lambdaEvidence(target, pair);
    const fault = lambdaFault(pair, evidence);
    log('lambda check', { alarm: alarm.alarmName, ...evidence, fault });
    if (fault) {
      const reason = `errors come from the backend Lambda (${fault}) - an API rollback would not fix them`;
      log('rollback skipped', { reason });
      return { action: 'skip', reason };
    }
  }

  if (!(await claimRollback(dt.table, from))) {
    log('rollback skipped', { reason: 'already claimed by a concurrent invocation' });
    return { action: 'skip', reason: 'already claimed' };
  }
  log('rolling back', { from: from.deployedAt, fromDeployment: from.deploymentId, to: to.deployedAt, spec: to.specKey });

  const description = `Rollback to ${to.deployedAt} (${to.deploymentId}) after alarm: ${alarm.alarmName}`;
  const deploymentId = await redeploy(target, to, description);

  const record = await recordDeployment(dt, {
    source: 'rollback',
    actor: `alarm:${alarm.alarmName}`,
    commitSha: to.commitSha,
    description,
    rolledBackFrom: from.deployedAt,
    // same API config as the verified target, and the Lambda was not at fault, so it counts as verified too
    verifiedAt: to.verifiedAt,
    force: true,
  });
  log('rollback complete', { deploymentId, record });
  return { action: 'rolled-back', from: from.deployedAt, to: to.deployedAt, deploymentId };
}
