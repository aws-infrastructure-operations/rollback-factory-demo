export type EnvName = 'dev' | 'prod';

export interface AlarmConfig {
  /** Alarm actions (SNS -> rollback Lambda) on/off. Alarms still change state either way. */
  notificationsEnabled: boolean;
  /** Optional e-mail subscribed to the alarm topic. */
  email?: string;
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
/** Release ids are UTC timestamps, e.g. 20261006T123005Z. `initial` is the placeholder release. */
export const RELEASE_ID_PATTERN = /^(\d{8}T\d{6}Z|initial)$/;

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
    },
    rollbackWindowMinutes,
  };
}
