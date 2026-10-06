import { RELEASE_ID_PATTERN } from '../lambda/shared/releases.js';

/** In promotion order. Only prod keeps its data when its stacks are deleted. */
export const ENV_NAMES = ['dev', 'testing', 'staging', 'prod'] as const;
export type EnvName = (typeof ENV_NAMES)[number];

export interface AlarmConfig {
  /** Alarm actions (SNS -> rollback Lambda) on/off. Alarms still change state either way. */
  notificationsEnabled: boolean;
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
  /**
   * Comment of the second distribution, frontend-user-<env>-integration: CI makes each release
   * live there first and runs the integration tests, and only then on frontendName.
   */
  integrationName: string;
  /** Every other resource: rollback-factory-demo-<resource>-<env>. */
  resourceName: (resource: string) => string;
  /** Site bucket, distribution, deployments bucket and table, in the main region. */
  stackName: string;
  /** Alarms, SNS topic and rollback Lambda. CloudFront only publishes metrics in us-east-1. */
  alarmsStackName: string;
  alarmsRegion: string;
  /**
   * The release the distribution serves right now (from scripts/live-context.ts).
   * `cdk deploy` keeps the origin path on it, so a deploy never undoes a rollback.
   */
  liveReleaseId?: string;
  /** Same for the integration distribution (from scripts/live-context.ts). */
  integrationReleaseId?: string;
  /** Whether stateful resources (buckets, table) survive stack deletion. */
  retainData: boolean;
  alarms: AlarmConfig;
  /** In the main stack; the rollback service writes rollback records to it. */
  deploymentsTableName: string;
  /**
   * The two CloudFront error-rate alarms that trigger a rollback, named
   * rollback-factory-demo-cloudfront-<name>-<env>: the rollback service picks its CloudFront manager
   * from the "cloudfront" type in the name.
   */
  alarmNames: { error4xx: string; error5xx: string };
  /** The rollback service's topic (rollback-service), in us-east-1 for these alarms. */
  rollbackTopicName: string;
  /** The rollback service's Lambda (rollback-service), invoked by rollback:trigger. */
  rollbackServiceFunctionName: string;
  /** The rollback service only acts if the latest release is younger than this. */
  rollbackWindowMinutes: number;
}

/** Optional overrides, e.g. from `cdk deploy -c liveReleaseId=...`. */
export interface ConfigOverrides {
  alarmNotifications?: string | boolean;
  rollbackWindowMinutes?: string | number;
  liveReleaseId?: string;
  integrationReleaseId?: string;
}

export const PROJECT_NAME = 'rollback-factory-demo';
/** This project's folder and stack name prefix: deploy-aws-cloudfront-<env> and deploy-aws-cloudfront-alarms-<env>. */
export const STACK_PREFIX = 'deploy-aws-cloudfront';
export const ALARMS_REGION = 'us-east-1';
/** Where the API is deployed; only used when the app runs outside the CDK CLI (which always sets CDK_DEFAULT_REGION). */
export const DEFAULT_REGION = 'eu-central-1';

export function getConfig(envName: string | undefined, overrides: ConfigOverrides = {}): EnvConfig {
  if (!ENV_NAMES.includes(envName as EnvName)) {
    throw new Error(`Unknown env "${envName}". Pass -c env=<${ENV_NAMES.join('|')}>`);
  }
  const releaseOverride = (name: 'liveReleaseId' | 'integrationReleaseId') => {
    const value = overrides[name] || undefined;
    if (value && !RELEASE_ID_PATTERN.test(value)) {
      throw new Error(`${name} must look like 20261006T123005Z, got "${value}"`);
    }
    return value;
  };
  const liveReleaseId = releaseOverride('liveReleaseId');
  const integrationReleaseId = releaseOverride('integrationReleaseId');
  const rollbackWindowMinutes = Number(overrides.rollbackWindowMinutes ?? 30);
  if (!(rollbackWindowMinutes > 0)) {
    throw new Error(`rollbackWindowMinutes must be a positive number, got ${overrides.rollbackWindowMinutes}`);
  }

  const resourceName = (resource: string) => `${PROJECT_NAME}-${resource}-${envName}`;

  return {
    envName: envName as EnvName,
    frontendName: `frontend-user-${envName}`,
    integrationName: `frontend-user-${envName}-integration`,
    resourceName,
    stackName: `${STACK_PREFIX}-${envName}`,
    alarmsStackName: `${STACK_PREFIX}-alarms-${envName}`,
    alarmsRegion: ALARMS_REGION,
    liveReleaseId,
    integrationReleaseId,
    retainData: envName === 'prod',
    alarms: {
      notificationsEnabled: String(overrides.alarmNotifications ?? 'true') !== 'false',
      error4xxRatePercent: 25,
      minRequests4xx: 20,
      error5xxRatePercent: 5,
      minRequests5xx: 5,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
    },
    deploymentsTableName: resourceName('frontend-deployments'),
    alarmNames: {
      error4xx: resourceName('cloudfront-frontend-user-4xx-rate'),
      error5xx: resourceName('cloudfront-frontend-user-5xx-rate'),
    },
    rollbackTopicName: resourceName('rollback-notifications'),
    rollbackServiceFunctionName: resourceName('rollback-service'),
    rollbackWindowMinutes,
  };
}
