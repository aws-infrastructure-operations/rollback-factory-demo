import type { SNSEvent } from 'aws-lambda';
import type { DeploymentRecord } from '../shared/deployments.js';

export type RollbackPlan =
  | { action: 'rollback'; from: DeploymentRecord; to: DeploymentRecord }
  | { action: 'skip'; reason: string };

export interface AlarmNotification {
  alarmName: string;
  newState: string;
  reason: string;
}

/** Keeps the ALARM transitions of this API's own alarms. */
export const ownAlarms = (alarms: AlarmNotification[], alarmNames: string[]) =>
  alarms.filter((a) => a.newState === 'ALARM' && alarmNames.includes(a.alarmName));

/** CloudWatch alarm notifications carried by an SNS event. */
export function parseAlarms(event: SNSEvent): AlarmNotification[] {
  return event.Records.map((r) => {
    const msg = JSON.parse(r.Sns.Message);
    return { alarmName: msg.AlarmName, newState: msg.NewStateValue, reason: msg.NewStateReason };
  });
}

/**
 * Decides whether to roll back, given the deployment history (newest first).
 * Only the latest deployment is ever rolled back, and only if it is recent:
 * an alarm long after a deploy is unlikely to be caused by it. The target is the
 * newest earlier deployment that passed integration tests (verifiedAt) and was
 * never rolled back itself - never just "the previous one", which may be broken.
 */
export function planRollback(records: DeploymentRecord[], now: Date, windowMinutes: number): RollbackPlan {
  const [latest] = records;
  if (!latest) return { action: 'skip', reason: 'no deployments recorded' };
  if (latest.source === 'rollback' || latest.source === 'restore') {
    return { action: 'skip', reason: `latest deployment (${latest.deployedAt}) is already a ${latest.source}` };
  }
  if (latest.rolledBackAt) {
    return { action: 'skip', reason: `latest deployment was already rolled back at ${latest.rolledBackAt}` };
  }

  const ageMinutes = (now.getTime() - new Date(latest.deployedAt).getTime()) / 60_000;
  if (ageMinutes > windowMinutes) {
    return {
      action: 'skip',
      reason: `latest deployment is ${Math.round(ageMinutes)} min old (window: ${windowMinutes} min)`,
    };
  }

  const to = records.find((r) => r.deployedAt < latest.deployedAt
    && r.deploymentId !== latest.deploymentId
    && r.verifiedAt
    && !r.rolledBackAt);
  if (!to) return { action: 'skip', reason: 'no earlier verified deployment to roll back to' };
  return { action: 'rollback', from: latest, to };
}

/** Manual restore request, sent by scripts/restore-deployment.ts instead of an SNS event. */
export interface RestoreRequest {
  restore: { deployedAt: string; reason?: string; actor?: string };
}

export const isRestoreRequest = (event: unknown): event is RestoreRequest =>
  typeof (event as RestoreRequest)?.restore?.deployedAt === 'string';

/** An API alarm and its paired alarm counting only the errors the backend Lambda produced. */
export interface AlarmPair {
  apiAlarm: string;
  lambdaAlarm: string;
  /** AWS/ApiGateway metric of the API alarm, e.g. 5XXError */
  apiMetric: string;
  /** access-log metric of the Lambda alarm, e.g. Lambda5XXError */
  lambdaMetric: string;
}

export interface LambdaEvidence {
  /** state of the paired Lambda alarm */
  lambdaAlarmState?: string;
  /** errors in the alarm's evaluation window: all of them, and those the Lambda produced */
  apiErrors: number;
  lambdaErrors: number;
}

/**
 * Why the errors behind an API alarm are the backend Lambda's fault, or undefined if
 * they are not. Then an API rollback would not help, since the API always invokes the
 * latest Lambda. The paired Lambda alarm is checked first; as both alarms are evaluated
 * independently it may not be in ALARM yet, so the Lambda is also at fault when it
 * produced at least half of the errors in the evaluation window.
 */
export function lambdaFault(pair: AlarmPair, evidence: LambdaEvidence): string | undefined {
  if (evidence.lambdaAlarmState === 'ALARM') return `${pair.lambdaAlarm} is in ALARM`;
  const { apiErrors, lambdaErrors } = evidence;
  if (apiErrors > 0 && lambdaErrors * 2 >= apiErrors) {
    return `the Lambda produced ${lambdaErrors} of the ${apiErrors} ${pair.apiMetric} responses`;
  }
  return undefined;
}

/**
 * Points every integration of the backend function in a spec at its "live" alias,
 * whatever version or alias the spec was recorded with, so an API rollback keeps
 * the latest code. Integrations of other functions are left alone.
 */
export function pointToAlias(spec: any, functionArn: string, aliasArn: string): any {
  const copy = structuredClone(spec);
  for (const methods of Object.values<any>(copy.paths ?? {})) {
    for (const op of Object.values<any>(methods)) {
      const integration = op?.['x-amazon-apigateway-integration'];
      const uri: unknown = integration?.uri;
      const match = typeof uri === 'string' ? uri.match(/\/functions\/(arn:[^/]+)\/invocations$/) : null;
      if (!match) continue;
      const arn = match[1];
      if (arn === functionArn || arn.startsWith(`${functionArn}:`)) {
        integration.uri = (uri as string).replace(arn, aliasArn);
      }
    }
  }
  return copy;
}

/** Lambda function ARNs (incl. version qualifier) used by the spec's integrations. */
export function lambdaArnsFromSpec(spec: any): string[] {
  const arns = new Set<string>();
  for (const methods of Object.values<any>(spec.paths ?? {})) {
    for (const op of Object.values<any>(methods)) {
      const uri: unknown = op?.['x-amazon-apigateway-integration']?.uri;
      const match = typeof uri === 'string' ? uri.match(/\/functions\/(arn:[^/]+)\/invocations$/) : null;
      if (match) arns.add(match[1]);
    }
  }
  return [...arns];
}
