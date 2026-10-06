export type EnvName = 'dev' | 'prod';

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
  apiName: string;
  stackName: string;
  stageName: string;
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
}

export const STAGE_NAME = 'v1';

export function getConfig(envName: string | undefined, overrides: ConfigOverrides = {}): EnvConfig {
  if (envName !== 'dev' && envName !== 'prod') {
    throw new Error(`Unknown env "${envName}". Pass -c env=dev or -c env=prod`);
  }
  const chaosFailureRate = Number(overrides.chaosFailureRate ?? 0);
  if (!(chaosFailureRate >= 0 && chaosFailureRate <= 1)) {
    throw new Error(`chaosFailureRate must be between 0 and 1, got ${overrides.chaosFailureRate}`);
  }

  return {
    envName,
    apiName: `api-user-${envName}`,
    stackName: `ApiUserStack-${envName}`,
    stageName: STAGE_NAME,
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
