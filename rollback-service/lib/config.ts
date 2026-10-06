/** In promotion order. Only prod keeps its data when its stacks are deleted. */
export const ENV_NAMES = ['dev', 'testing', 'staging', 'prod'] as const;
export type EnvName = (typeof ENV_NAMES)[number];

export const PROJECT_NAME = 'rollback-factory-demo';
export const STACK_PREFIX = 'rollback-service';
export const MAIN_REGION_FALLBACK = 'eu-central-1';
/** CloudFront publishes its metrics, so its alarms and their topic, only in us-east-1. */
export const EDGE_REGION = 'us-east-1';

/**
 * Rollback alarms are named rollback-factory-demo-<type>-<name>-<metric>-<env>. The type picks the
 * rollback manager; the target of each manager is the project stack of that environment.
 */
export const ALARM_TYPES = {
  apigateway: { stack: (env: string) => `deploy-aws-api-gateway-${env}` },
  cloudfront: { stack: (env: string) => `deploy-aws-cloudfront-${env}` },
  lambda: { stack: (env: string) => `deploy-aws-lambda-${env}` },
} as const;
export type AlarmType = keyof typeof ALARM_TYPES;

/** Settings of the Lambda rollback manager (see README). */
export const LAMBDA_ROLLBACK_SETTINGS = {
  /** How often EventBridge runs the scheduled check (sync, stable marking, alarm re-check). */
  checkIntervalMinutes: 5,
  /** Minimum time between two rollbacks of the same function. */
  cooldownMinutes: 3,
  /** How long a version must be live, with all its alarms OK, before it is marked stable. */
  stableAfterMinutes: 5,
  /** How far back to look for errors on the alias, to tell a $LATEST-only failure from a failing alias. */
  liveErrorsLookbackMinutes: 5,
} as const;

export interface EnvConfig {
  envName: EnvName;
  /** rollback-service-<env> (main region) */
  stackName: string;
  /** rollback-service-us-east-1-<env> (the topic CloudFront alarms publish to) */
  edgeStackName: string;
  resourceName: (resource: string) => string;
  /** rollback-factory-demo-rollback-service-<env>: the one rollback Lambda */
  functionName: string;
  /** rollback-factory-demo-rollback-notifications-<env>, in the main region and in us-east-1 */
  topicName: string;
  /**
   * Lambda manager: version archive (metadata). Not the name deploy-aws-lambda used before the
   * rollback service existed (rollback-factory-demo-lambda-versions-<env>), so it never collides with
   * that table, which prod keeps after the old stack resources are removed.
   */
  versionsTableName: string;
  /** Optional e-mail subscribed to both topics (-c alarmEmail=...). */
  alarmEmail?: string;
  retainData: boolean;
}

export interface ConfigOverrides {
  alarmEmail?: string;
}

export function getConfig(envName: string | undefined, overrides: ConfigOverrides = {}): EnvConfig {
  if (!ENV_NAMES.includes(envName as EnvName)) {
    throw new Error(`Unknown env "${envName}". Pass -c env=<${ENV_NAMES.join('|')}>`);
  }
  const resourceName = (resource: string) => `${PROJECT_NAME}-${resource}-${envName}`;
  return {
    envName: envName as EnvName,
    stackName: `${STACK_PREFIX}-${envName}`,
    edgeStackName: `${STACK_PREFIX}-${EDGE_REGION}-${envName}`,
    resourceName,
    functionName: resourceName('rollback-service'),
    topicName: resourceName('rollback-notifications'),
    versionsTableName: resourceName('lambda-archive'),
    alarmEmail: overrides.alarmEmail || undefined,
    retainData: envName === 'prod',
  };
}

/** An alarm name split into its parts, or undefined if it doesn't follow the convention. */
export interface ParsedAlarmName {
  type: AlarmType;
  /** What it watches and its metric, e.g. api-user-5xx-rate */
  name: string;
  env: EnvName;
}

const ALARM_NAME = new RegExp(
  `^${PROJECT_NAME}-(${Object.keys(ALARM_TYPES).join('|')})-(.+)-(${ENV_NAMES.join('|')})$`,
);

export function parseAlarmName(alarmName: string): ParsedAlarmName | undefined {
  const match = ALARM_NAME.exec(alarmName);
  return match ? { type: match[1] as AlarmType, name: match[2], env: match[3] as EnvName } : undefined;
}

/** rollback-factory-demo-<type>-<name>-<env>: how the projects name their rollback alarms. */
export const alarmName = (type: AlarmType, name: string, env: string) => `${PROJECT_NAME}-${type}-${name}-${env}`;
