/** In promotion order. Only prod keeps its data when its stack is deleted. */
export const ENV_NAMES = ['dev', 'testing', 'staging', 'prod'] as const;
export type EnvName = (typeof ENV_NAMES)[number];

export const PROJECT_NAME = 'rollback-factory-demo';
/** The service's own name, like api-user for the API: the function is service-lambda-<env>. */
export const SERVICE_NAME = 'service-lambda';
/** Clients call this alias; only the rollback system and promotion move it. */
export const LIVE_ALIAS = 'live';
/** Every deploy points this alias at the newly published version; CI tests it before promoting. */
export const INTEGRATION_ALIAS = 'integration';

/** System-wide rollback settings (see README). */
export const ROLLBACK_SETTINGS = {
  /** How often EventBridge re-checks alarms still in ALARM, syncs and marks stable versions. */
  checkIntervalMinutes: 5,
  /** Minimum time between two rollbacks of the same function, so the alarm can judge the new version. */
  cooldownMinutes: 3,
  /** How long a version must be live, with all its alarms OK, before it is marked stable. */
  stableAfterMinutes: 5,
  /** How far back to look for errors on the alias, to tell a $LATEST-only failure from a failing live version. */
  liveErrorsLookbackMinutes: 5,
} as const;

export interface EnvConfig {
  envName: EnvName;
  /** service-lambda-<env> */
  functionName: string;
  /** rollback-factory-demo-lambda-<env> */
  stackName: string;
  /** Every other resource: rollback-factory-demo-<resource>-<env>. */
  resourceName: (resource: string) => string;
  /** Replaces <env> in rollback-config.json names. */
  resolveName: (name: string) => string;
  rollbackFunctionName: string;
  versionsTableName: string;
  rollbackTopicName: string;
  /** rollback-factory-demo-service-lambda-errors-<env>: named after the function it watches. */
  errorsAlarmName: string;
  /**
   * The version `live` serves right now (from scripts/live-context.ts). When set, `cdk deploy`
   * leaves `live` there and only moves `integration` to the new version.
   */
  liveLambdaVersion?: string;
  /** Whether the versions table and artifacts bucket survive stack deletion. */
  retainData: boolean;
}

export interface ConfigOverrides {
  liveLambdaVersion?: string;
}

export function getConfig(envName: string | undefined, overrides: ConfigOverrides = {}): EnvConfig {
  if (!ENV_NAMES.includes(envName as EnvName)) {
    throw new Error(`Unknown env "${envName}". Pass -c env=<${ENV_NAMES.join('|')}>`);
  }
  const liveLambdaVersion = overrides.liveLambdaVersion || undefined;
  if (liveLambdaVersion && !/^\d+$/.test(liveLambdaVersion)) {
    throw new Error(`liveLambdaVersion must be a published version number, got "${liveLambdaVersion}"`);
  }
  const resourceName = (resource: string) => `${PROJECT_NAME}-${resource}-${envName}`;

  return {
    envName: envName as EnvName,
    functionName: `${SERVICE_NAME}-${envName}`,
    stackName: resourceName('lambda'),
    resourceName,
    resolveName: (name: string) => name.replaceAll('<env>', envName as string),
    rollbackFunctionName: resourceName('lambda-rollback'),
    versionsTableName: resourceName('lambda-versions'),
    rollbackTopicName: resourceName('lambda-notifications'),
    errorsAlarmName: resourceName(`${SERVICE_NAME}-errors`),
    liveLambdaVersion,
    retainData: envName === 'prod',
  };
}
