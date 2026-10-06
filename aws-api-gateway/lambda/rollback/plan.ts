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
