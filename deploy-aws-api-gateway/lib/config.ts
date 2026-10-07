/** In promotion order. Only prod keeps its data when its stacks are deleted. */
export const ENV_NAMES = ['dev', 'testing', 'staging', 'prod'] as const;
export type EnvName = (typeof ENV_NAMES)[number];

export interface AlarmConfig {
  /** Alarm actions (SNS -> rollback service) on/off. Alarms still change state either way. */
  notificationsEnabled: boolean;
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

/** The API's resources: each is served by its own Lambda function. */
export const BACKENDS = ['users', 'messages', 'orders'] as const;
export type Backend = (typeof BACKENDS)[number];

/** One backend Lambda: what serves /<resource>, and the alarm the rollback service rolls it back on. */
export interface BackendFunction {
  /** rollback-factory-demo-api-<resource>-<env>, registered in rollback-service/rollback-config.json */
  functionName: string;
  /**
   * rollback-factory-demo-lambda-api-<resource>-errors-<env>: the "lambda" type routes it to the rollback
   * service's Lambda manager, which moves the function's live alias back.
   */
  errorsAlarmName: string;
}

/** The CDK context key that pins a backend's live alias, e.g. liveUsersVersion. */
export const liveVersionContextKey = (backend: Backend) => `live${backend[0].toUpperCase()}${backend.slice(1)}Version`;

export interface EnvConfig {
  envName: EnvName;
  /** The REST API keeps the story's name: api-user-<env>. */
  apiName: string;
  stackName: string;
  /** Every other resource: rollback-factory-demo-<resource>-<env>. */
  resourceName: (resource: string) => string;
  /**
   * The two alarms that trigger a rollback, named rollback-factory-demo-apigateway-<name>-<env>:
   * the rollback service picks its API Gateway manager from the "apigateway" type in the name.
   */
  alarmNames: { error4xx: string; error5xx: string };
  /**
   * Paired with alarmNames: the same rates, counting only errors the backend Lambda
   * produced. While one is in ALARM the rollback service skips the API rollback.
   */
  lambdaAlarmNames: { error4xx: string; error5xx: string };
  /** The backend Lambda of each resource. */
  backends: Record<Backend, BackendFunction>;
  /** The rollback service's topic in this region (rollback-service), which the alarms publish to. */
  rollbackTopicName: string;
  /** The rollback service's Lambda (rollback-service), invoked by the restore and trigger scripts. */
  rollbackServiceFunctionName: string;
  /** CloudWatch namespace of the metrics derived from the access logs. */
  metricsNamespace: string;
  stageName: string;
  /** CI deploys here first and runs the integration tests, then promotes to stageName. */
  integrationStageName: string;
  /**
   * Where the stages are mapped on the environment's shared API domain (deploy-aws-dns-api-domains):
   * https://api.dev.rollback…/user/v1/users is stage v1's /users. Undefined for environments
   * without an API domain (testing, staging).
   */
  customDomain?: CustomDomain;
  /**
   * What stage v1 and each backend's `live` alias serve right now (from scripts/live-context.ts).
   * When set, `cdk deploy` leaves them there and only updates the integration stage.
   */
  live?: { deploymentId?: string; lambdaVersions: Partial<Record<Backend, string>> };
  /** Whether stateful resources (user pool, bucket, table) survive stack deletion. */
  retainData: boolean;
  alarms: AlarmConfig;
  /** The rollback service only acts if the latest deployment is younger than this. */
  rollbackWindowMinutes: number;
  /** 0..1 share of API requests the backend fails with a 500 - for demoing rollbacks. */
  chaosFailureRate: number;
  /**
   * Identifies the deploy (CI: <run id>.<attempt>). Set into each backend's configuration, so every
   * deploy publishes a new version of both, even when their code didn't change.
   */
  deployId?: string;
}

/** An API's stages on its environment's API domain. */
export interface CustomDomain {
  /** api.dev.rollback.ionuteliantudor.com, or api.rollback.ionuteliantudor.com for prod */
  domainName: string;
  /** The mapping key of each stage: user/v1 and user/integration. */
  basePaths: { stage: string; integration: string };
}

/** Optional overrides, e.g. from `cdk deploy -c chaosFailureRate=1`. */
export interface ConfigOverrides {
  alarmNotifications?: string | boolean;
  rollbackWindowMinutes?: string | number;
  chaosFailureRate?: string | number;
  deployId?: string;
  liveDeploymentId?: string;
  /** liveUsersVersion, liveMessagesVersion, liveOrdersVersion (see liveVersionContextKey) */
  [liveVersion: `live${string}Version`]: string | undefined;
}

export const STAGE_NAME = 'v1';
export const INTEGRATION_STAGE_NAME = 'integration';
export const PROJECT_NAME = 'rollback-factory-demo';
/** This project's folder and stack name prefix: the stack is deploy-aws-api-gateway-<env>. */
export const STACK_PREFIX = 'deploy-aws-api-gateway';
/** The REST API's name without the environment: api-user-<env> is the API, api-user names its alarms. */
export const API_NAME = 'api-user';
/** This API's path on the environment's API domain: https://<api domain>/user/<stage>/... */
export const API_PATH = 'user';

/** The zone of deploy-aws-dns. */
export const ZONE_NAME = 'rollback.ionuteliantudor.com';
/** The environments deploy-aws-dns-api-domains creates an API domain for. */
export const API_DOMAIN_ENVS: readonly EnvName[] = ['dev', 'prod'];
/**
 * dev: api.dev.rollback…; prod without a prefix: api.rollback…. The same rule as
 * deploy-aws-dns/lib/config.ts (a test keeps them equal).
 */
export function apiDomain(envName: string): string {
  return envName === 'prod' ? `api.${ZONE_NAME}` : `api.${envName}.${ZONE_NAME}`;
}

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
    stackName: `${STACK_PREFIX}-${envName}`,
    resourceName,
    alarmNames: {
      error4xx: resourceName(`apigateway-${API_NAME}-4xx-rate`),
      error5xx: resourceName(`apigateway-${API_NAME}-5xx-rate`),
    },
    lambdaAlarmNames: {
      error4xx: resourceName(`apigateway-${API_NAME}-handler-4xx-rate`),
      error5xx: resourceName(`apigateway-${API_NAME}-handler-5xx-rate`),
    },
    backends: Object.fromEntries(BACKENDS.map((backend) => [backend, {
      functionName: resourceName(`api-${backend}`),
      errorsAlarmName: resourceName(`lambda-api-${backend}-errors`),
    }])) as Record<Backend, BackendFunction>,
    rollbackTopicName: resourceName('rollback-notifications'),
    rollbackServiceFunctionName: resourceName('rollback-service'),
    metricsNamespace: `${PROJECT_NAME}/${API_NAME}-${envName}`,
    stageName: STAGE_NAME,
    integrationStageName: INTEGRATION_STAGE_NAME,
    customDomain: API_DOMAIN_ENVS.includes(envName as EnvName)
      ? {
        domainName: apiDomain(envName as string),
        basePaths: { stage: `${API_PATH}/${STAGE_NAME}`, integration: `${API_PATH}/${INTEGRATION_STAGE_NAME}` },
      }
      : undefined,
    live: live(overrides),
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
    rollbackWindowMinutes: Number(overrides.rollbackWindowMinutes ?? 30),
    chaosFailureRate,
    deployId: overrides.deployId ? String(overrides.deployId) : undefined,
  };
}

/** The live context CI passes (-c liveDeploymentId / -c live<Backend>Version), if any. */
function live(overrides: ConfigOverrides): EnvConfig['live'] {
  const lambdaVersions = Object.fromEntries(BACKENDS
    .map((backend) => [backend, overrides[liveVersionContextKey(backend) as `live${string}Version`]])
    .filter(([, version]) => version)) as Partial<Record<Backend, string>>;
  if (!overrides.liveDeploymentId && Object.keys(lambdaVersions).length === 0) return undefined;
  return { deploymentId: overrides.liveDeploymentId || undefined, lambdaVersions };
}
