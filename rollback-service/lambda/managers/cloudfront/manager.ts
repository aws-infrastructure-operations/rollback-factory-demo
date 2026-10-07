/**
 * CloudFront rollback manager. For a cloudfront rate alarm in ALARM, if the latest deployment is
 * younger than the rollback window, it points the distribution's origin path back at the previous
 * verified release, invalidates /* and records the rollback. It doesn't wait for the distribution
 * to deploy (a few minutes).
 *
 * Everything about the target comes from the frontend stack's RollbackTarget output (see targets.ts).
 */
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { createDeploymentStore } from './deployments.js';
import { AlarmNotification, planRollback } from './plan.js';
import { getLiveReleaseId, switchRelease } from './releases.js';

/** The frontend stack's RollbackTarget output. */
export interface CloudFrontRollbackTarget {
  frontendName: string;
  /** frontend-user-<env> only: the integration distribution is never rolled back. */
  distributionId: string;
  table: string;
  /** The rate alarms that trigger a rollback. */
  alarmNames: string[];
  rollbackWindowMinutes: number;
}

/** A release chosen by hand (the dashboard's Restore button), named by its record's deployedAt. */
export interface RestoreRequest {
  deployedAt: string;
  reason?: string;
  actor?: string;
}

const cloudfront = new CloudFrontClient({});
const log = (msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ manager: 'cloudfront', msg, ...data }));

/**
 * Points the distribution back at the release recorded at `req.deployedAt`, invalidates /* and
 * records a "restore", like deploy-aws-cloudfront's deployment:restore. Not verified: the release
 * has to pass the integration tests again. Skips (changing nothing) when it is already live.
 */
export async function restore(
  target: CloudFrontRollbackTarget,
  req: RestoreRequest,
  { client = cloudfront, now = () => new Date() } = {},
) {
  const store = createDeploymentStore({ table: target.table, frontendName: target.frontendName });
  const to = await store.get(req.deployedAt);
  // a recreated distribution starts a new history under the same name
  if (!to || to.distributionId !== target.distributionId) {
    throw new Error(`No release of ${target.frontendName} recorded at ${req.deployedAt}`);
  }
  const liveReleaseId = await getLiveReleaseId(client, target.distributionId);
  if (liveReleaseId === to.releaseId) {
    log('restore skipped', { reason: 'already live', releaseId: to.releaseId });
    return { action: 'skip', reason: `${target.frontendName} already serves release ${to.releaseId}` };
  }

  log('restoring', { to: to.releaseId, toDeployedAt: to.deployedAt, actor: req.actor });
  const switched = await switchRelease(client, target.distributionId, to.releaseId, `restore-${to.deployedAt}-${now().getTime()}`);
  const description = `Restore to ${to.releaseId} (recorded ${to.deployedAt})${req.reason ? `: ${req.reason}` : ''}`;
  const record = await store.record({
    frontendName: target.frontendName,
    releaseId: to.releaseId,
    originPath: to.originPath,
    distributionId: target.distributionId,
    manifestKey: to.manifestKey,
    invalidationId: switched.invalidationId,
    previousReleaseId: switched.previousReleaseId,
    source: 'restore',
    actor: req.actor ?? 'manual',
    commit: to.commit,
    description,
  }, { now: now(), force: true });

  log('restore complete', { ...switched, deployedAt: record?.deployedAt });
  return {
    action: 'restored',
    from: switched.previousReleaseId,
    to: to.releaseId,
    invalidationId: switched.invalidationId,
    deployedAt: record?.deployedAt,
  };
}

export async function handleAlarm(
  target: CloudFrontRollbackTarget,
  alarm: AlarmNotification,
  { client = cloudfront, now = () => new Date() } = {},
) {
  if (alarm.newState !== 'ALARM') return { action: 'skip', reason: `state is ${alarm.newState}, not ALARM` };
  if (!target.alarmNames.includes(alarm.alarmName)) {
    return { action: 'skip', reason: `${alarm.alarmName} doesn't trigger a rollback of ${target.frontendName}` };
  }
  log('alarm received', { alarm });

  const store = createDeploymentStore({ table: target.table, frontendName: target.frontendName });
  const [records, liveReleaseId] = await Promise.all([store.list(20), getLiveReleaseId(client, target.distributionId)]);
  const plan = planRollback(records, liveReleaseId, now(), target.rollbackWindowMinutes);
  if (plan.action === 'skip') {
    log('rollback skipped', { reason: plan.reason, liveReleaseId });
    return plan;
  }
  const { from, to } = plan;

  // 4xx and 5xx can fire together: only the invocation that claims the deployment rolls back
  if (!(await store.claimRollback(from))) {
    log('rollback skipped', { reason: 'already claimed by a concurrent invocation' });
    return { action: 'skip', reason: 'already claimed' };
  }
  log('rolling back', { from: from.releaseId, fromDeployedAt: from.deployedAt, to: to.releaseId, toDeployedAt: to.deployedAt });

  const switched = await switchRelease(client, target.distributionId, to.releaseId, `rollback-${from.deployedAt}`);
  const description = `Rollback from ${from.releaseId} to ${to.releaseId} after alarm: ${alarm.alarmName}`;
  const record = await store.record({
    frontendName: from.frontendName,
    releaseId: to.releaseId,
    originPath: to.originPath,
    distributionId: target.distributionId,
    manifestKey: to.manifestKey,
    invalidationId: switched.invalidationId,
    previousReleaseId: switched.previousReleaseId,
    source: 'rollback',
    actor: `alarm:${alarm.alarmName}`,
    commit: to.commit,
    description,
    rolledBackFrom: from.deployedAt,
    // the same release that passed the tests before, so it counts as verified
    verifiedAt: to.verifiedAt,
  }, { force: true });

  log('rollback complete', { ...switched, deployedAt: record?.deployedAt });
  return {
    action: 'rolledBack',
    from: from.releaseId,
    to: to.releaseId,
    invalidationId: switched.invalidationId,
    deployedAt: record?.deployedAt,
  };
}
