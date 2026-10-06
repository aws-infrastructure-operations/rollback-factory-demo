/**
 * Subscribed to the frontend's alarm topic (us-east-1). When the CloudFront 4xx/5xx alarm goes
 * into ALARM and the latest deployment is younger than ROLLBACK_WINDOW_MINUTES, it points the
 * distribution's origin path back at the previous verified release, invalidates /* and records
 * the rollback. It doesn't wait for the distribution to deploy (a few minutes).
 */
import type { SNSEvent } from 'aws-lambda';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { createDeploymentStore } from '../shared/deployments.js';
import { getLiveReleaseId, switchRelease } from '../shared/releases.js';
import { ownAlarms, parseAlarms, planRollback } from './plan.js';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
};

const DISTRIBUTION_ID = env('DISTRIBUTION_ID');
const WINDOW_MINUTES = Number(env('ROLLBACK_WINDOW_MINUTES'));
const ALARM_NAMES = env('ALARM_NAMES').split(',');

const cloudfront = new CloudFrontClient({});
// the table lives in the main region, the Lambda in us-east-1 next to the alarms
const store = createDeploymentStore({
  table: env('DEPLOYMENTS_TABLE'),
  frontendName: env('FRONTEND_NAME'),
  region: env('DEPLOYMENTS_TABLE_REGION'),
});

const log = (msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...data }));

export const handler = async (event: SNSEvent) => {
  const alarms = ownAlarms(parseAlarms(event), ALARM_NAMES);
  if (alarms.length === 0) {
    log('no ALARM transition of this frontend in event, nothing to do');
    return { action: 'skip', reason: 'no ALARM transition of this frontend' };
  }
  const alarmNames = alarms.map((a) => a.alarmName).join(', ');
  log('alarm received', { alarms });

  const [records, liveReleaseId] = await Promise.all([
    store.list(20),
    getLiveReleaseId(cloudfront, DISTRIBUTION_ID),
  ]);
  const plan = planRollback(records, liveReleaseId, new Date(), WINDOW_MINUTES);
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

  const switched = await switchRelease(cloudfront, DISTRIBUTION_ID, to.releaseId, `rollback-${from.deployedAt}`);
  const description = `Rollback from ${from.releaseId} to ${to.releaseId} after alarm: ${alarmNames}`;
  const record = await store.record({
    frontendName: from.frontendName,
    releaseId: to.releaseId,
    originPath: to.originPath,
    distributionId: DISTRIBUTION_ID,
    manifestKey: to.manifestKey,
    invalidationId: switched.invalidationId,
    previousReleaseId: switched.previousReleaseId,
    source: 'rollback',
    actor: `alarm:${alarmNames}`,
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
};
