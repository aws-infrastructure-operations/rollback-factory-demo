import { RELEASE_ID_PATTERN } from '../lambda/shared/releases.js';

export type EnvName = 'dev' | 'prod';

export interface AlarmConfig {
  /** Alarm actions (SNS -> rollback Lambda) on/off. Alarms still change state either way. */
  notificationsEnabled: boolean;
  /** Optional e-mail subscribed to the alarm topic. */
  email?: string;
  /** Alarm when more than this % of requests in a minute are 4xx ... */
  error4xxRatePercent: number;
  /** ... and the minute had at least this many requests (keeps the smoke test's 404 from tripping it). */
  minRequests4xx: number;
  error5xxRatePercent: number;
  minRequests5xx: number;
  /** "datapointsToAlarm out of evaluationPeriods" one-minute periods. */
  evaluationPeriods: number;
  datapointsToAlarm: number;
}

export interface EnvConfig {
  envName: EnvName;
  /** The distribution keeps the story's name: frontend-user-<env>. */
  frontendName: string;
  /** Every other resource: rollback-factory-demo-<resource>-<env>. */
  resourceName: (resource: string) => string;
  /** Site bucket, distribution, deployments bucket and table, in the main region. */
  stackName: string;
  /** Alarms, SNS topic and rollback Lambda. CloudFront only publishes metrics in us-east-1. */
  alarmsStackName: string;
  alarmsRegion: string;
  /** The api-user stack of the same environment; the app is built with its outputs. */
  apiStackName: string;
  /**
   * The release the distribution serves right now (from scripts/live-context.ts).
   * `cdk deploy` keeps the origin path on it, so a deploy never undoes a rollback.
   */
  liveReleaseId?: string;
  /** Whether stateful resources (buckets, table) survive stack deletion. */
  retainData: boolean;
  alarms: AlarmConfig;
  /** The two CloudFront error-rate alarms the rollback Lambda reacts to. */
  alarmNames: { error4xx: string; error5xx: string };
  /** The rollback Lambda only acts if the latest release is younger than this. */
  rollbackWindowMinutes: number;
}

/** Optional overrides, e.g. from `cdk deploy -c liveReleaseId=... -c alarmEmail=...`. */
export interface ConfigOverrides {
  alarmNotifications?: string | boolean;
  alarmEmail?: string;
  rollbackWindowMinutes?: string | number;
  liveReleaseId?: string;
}

export const PROJECT_NAME = 'rollback-factory-demo';
export const ALARMS_REGION = 'us-east-1';
/** Where the API is deployed; only used when the app runs outside the CDK CLI (which always sets CDK_DEFAULT_REGION). */
export const DEFAULT_REGION = 'eu-central-1';

export function getConfig(envName: string | undefined, overrides: ConfigOverrides = {}): EnvConfig {
  if (envName !== 'dev' && envName !== 'prod') {
    throw new Error(`Unknown env "${envName}". Pass -c env=dev or -c env=prod`);
  }
  const liveReleaseId = overrides.liveReleaseId || undefined;
  if (liveReleaseId && !RELEASE_ID_PATTERN.test(liveReleaseId)) {
    throw new Error(`liveReleaseId must look like 20261006T123005Z, got "${liveReleaseId}"`);
  }
  const rollbackWindowMinutes = Number(overrides.rollbackWindowMinutes ?? 30);
  if (!(rollbackWindowMinutes > 0)) {
    throw new Error(`rollbackWindowMinutes must be a positive number, got ${overrides.rollbackWindowMinutes}`);
  }

  const resourceName = (resource: string) => `${PROJECT_NAME}-${resource}-${envName}`;

  return {
    envName,
    frontendName: `frontend-user-${envName}`,
    resourceName,
    stackName: resourceName('frontend'),
    alarmsStackName: resourceName('frontend-alarms'),
    alarmsRegion: ALARMS_REGION,
    apiStackName: `${PROJECT_NAME}-${envName}`,
    liveReleaseId,
    retainData: envName === 'prod',
    alarms: {
      notificationsEnabled: String(overrides.alarmNotifications ?? 'true') !== 'false',
      email: overrides.alarmEmail || undefined,
      error4xxRatePercent: 25,
      minRequests4xx: 20,
      error5xxRatePercent: 5,
      minRequests5xx: 5,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
    },
    alarmNames: { error4xx: resourceName('frontend-4xx-rate'), error5xx: resourceName('frontend-5xx-rate') },
    rollbackWindowMinutes,
  };
}
