/** In promotion order. Only prod keeps its data when its stacks are deleted. */
export const ENV_NAMES = ['dev', 'testing', 'staging', 'prod'] as const;
export type EnvName = (typeof ENV_NAMES)[number];

export interface AlarmConfig {
  /** Alarm actions (SNS -> rollback Lambda) on/off. Alarms still change state either way. */
  notificationsEnabled: boolean;
  /** Optional e-mail subscribed to the alarm topic. */
  email?: string;
  /** Alarm when more than this % of requests in a minute are 4xx ... */
  error4xxRatePercent: number;
  /** ... and the minute had at least this many requests (keeps integration tests from tripping it). */
  minRequests4xx: number;
  error5xxRatePercent: number;
  minRequests5xx: number;
  /** "datapointsToAlarm out of evaluationPeriods" one-minute periods. */
  evaluationPeriods: number;
  datapointsToAlarm: number;
}

export interface EnvConfig {
  envName: EnvName;
  /** The REST API keeps the story's name: api-user-<env>. */
  apiName: string;
  stackName: string;
  /** Every other resource: rollback-factory-demo-<resource>-<env>. */
  resourceName: (resource: string) => string;
  /** The two alarms the rollback Lambda reacts to. */
  alarmNames: { error4xx: string; error5xx: string };
  /**
   * Paired with alarmNames: the same rates, counting only errors the backend Lambda
   * produced. While one is in ALARM the rollback Lambda skips the API rollback.
   */
  lambdaAlarmNames: { error4xx: string; error5xx: string };
  /** CloudWatch namespace of the metrics derived from the access logs. */
  metricsNamespace: string;
  stageName: string;
  /** CI deploys here first and runs the integration tests, then promotes to stageName. */
  integrationStageName: string;
  /**
   * What stage v1 and the handler's `live` alias serve right now (from scripts/live-context.ts).
   * When set, `cdk deploy` leaves them there and only updates the integration stage.
   */
  live?: { deploymentId?: string; lambdaVersion?: string };
  /** Whether stateful resources (user pool, bucket, table) survive stack deletion. */
  retainData: boolean;
  alarms: AlarmConfig;
  /** The rollback Lambda only acts if the latest deployment is younger than this. */
  rollbackWindowMinutes: number;
  /** 0..1 share of API requests the backend fails with a 500 - for demoing rollbacks. */
  chaosFailureRate: number;
}

/** Optional overrides, e.g. from `cdk deploy -c alarmEmail=... -c chaosFailureRate=1`. */
export interface ConfigOverrides {
  alarmNotifications?: string | boolean;
  alarmEmail?: string;
  rollbackWindowMinutes?: string | number;
  chaosFailureRate?: string | number;
  liveDeploymentId?: string;
  liveLambdaVersion?: string;
}

export const STAGE_NAME = 'v1';
export const INTEGRATION_STAGE_NAME = 'integration';
export const PROJECT_NAME = 'rollback-factory-demo';
/** The REST API's name without the environment: api-user-<env> is the API, api-user names its alarms. */
export const API_NAME = 'api-user';

export function getConfig(envName: string | undefined, overrides: ConfigOverrides = {}): EnvConfig {
  if (!ENV_NAMES.includes(envName as EnvName)) {
    throw new Error(`Unknown env "${envName}". Pass -c env=<${ENV_NAMES.join('|')}>`);
  }
  const chaosFailureRate = Number(overrides.chaosFailureRate ?? 0);
  if (!(chaosFailureRate >= 0 && chaosFailureRate <= 1)) {
    throw new Error(`chaosFailureRate must be between 0 and 1, got ${overrides.chaosFailureRate}`);
  }

  const resourceName = (resource: string) => `${PROJECT_NAME}-${resource}-${envName}`;

  return {
    envName: envName as EnvName,
    apiName: `${API_NAME}-${envName}`,
    stackName: `${PROJECT_NAME}-${envName}`,
    resourceName,
    alarmNames: { error4xx: resourceName(`${API_NAME}-4xx-rate`), error5xx: resourceName(`${API_NAME}-5xx-rate`) },
    lambdaAlarmNames: { error4xx: resourceName('lambda-4xx-rate'), error5xx: resourceName('lambda-5xx-rate') },
    metricsNamespace: `${PROJECT_NAME}/${API_NAME}-${envName}`,
    stageName: STAGE_NAME,
    integrationStageName: INTEGRATION_STAGE_NAME,
    live: overrides.liveDeploymentId || overrides.liveLambdaVersion
      ? { deploymentId: overrides.liveDeploymentId || undefined, lambdaVersion: overrides.liveLambdaVersion || undefined }
      : undefined,
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
    rollbackWindowMinutes: Number(overrides.rollbackWindowMinutes ?? 30),
    chaosFailureRate,
  };
}
