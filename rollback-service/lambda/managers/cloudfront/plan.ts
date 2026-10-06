import type { SNSEvent } from 'aws-lambda';
import type { DeploymentRecord } from './deployments.js';

export type RollbackPlan =
  | { action: 'rollback'; from: DeploymentRecord; to: DeploymentRecord }
  | { action: 'skip'; reason: string };

export interface AlarmNotification {
  alarmName: string;
  newState: string;
  reason: string;
}

/** CloudWatch alarm notifications carried by an SNS event. */
export function parseAlarms(event: SNSEvent): AlarmNotification[] {
  return (event.Records ?? []).map((r) => {
    const msg = JSON.parse(r.Sns.Message);
    return { alarmName: msg.AlarmName, newState: msg.NewStateValue, reason: msg.NewStateReason };
  });
}

/** Keeps the ALARM transitions of this frontend's own alarms. */
export const ownAlarms = (alarms: AlarmNotification[], alarmNames: string[]) =>
  alarms.filter((a) => a.newState === 'ALARM' && alarmNames.includes(a.alarmName));

/**
 * Decides whether to roll back, given the deployment history (newest first) and the release
 * the distribution serves. Only the latest deployment is ever rolled back, and only if it is
 * recent: an alarm long after a deploy is unlikely to be caused by it. The target is the
 * newest earlier deployment of another release that passed the integration tests (verifiedAt)
 * - never just "the previous one", which may be broken - and whose release was never rolled
 * back.
 */
export function planRollback(
  records: DeploymentRecord[],
  liveReleaseId: string | undefined,
  now: Date,
  windowMinutes: number,
): RollbackPlan {
  const [latest] = records;
  if (!latest) return { action: 'skip', reason: 'no deployments recorded' };
  if (latest.source === 'rollback' || latest.source === 'restore') {
    return { action: 'skip', reason: `latest deployment (${latest.deployedAt}) is already a ${latest.source}` };
  }
  if (latest.rolledBackAt) {
    return { action: 'skip', reason: `latest deployment was already rolled back at ${latest.rolledBackAt}` };
  }
  if (latest.releaseId !== liveReleaseId) {
    // someone switched the distribution without recording it: don't guess what is live
    return {
      action: 'skip',
      reason: `the distribution serves ${liveReleaseId ?? 'no release'}, but the latest record is ${latest.releaseId}`,
    };
  }

  const ageMinutes = (now.getTime() - new Date(latest.deployedAt).getTime()) / 60_000;
  if (ageMinutes > windowMinutes) {
    return {
      action: 'skip',
      reason: `latest deployment is ${Math.round(ageMinutes)} min old (window: ${windowMinutes} min)`,
    };
  }

  const rolledBackReleases = new Set(records.filter((r) => r.rolledBackAt).map((r) => r.releaseId));
  const to = records.find((r) => r.deployedAt < latest.deployedAt
    && r.releaseId !== latest.releaseId
    && r.verifiedAt
    && !rolledBackReleases.has(r.releaseId));
  if (!to) return { action: 'skip', reason: 'no earlier verified release to roll back to' };
  return { action: 'rollback', from: latest, to };
}
