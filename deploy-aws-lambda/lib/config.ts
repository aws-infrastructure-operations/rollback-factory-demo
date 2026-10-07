/** In promotion order. Only prod keeps its data when its stack is deleted. */
export const ENV_NAMES = ['dev', 'testing', 'staging', 'prod'] as const;
/**
 * A pull request's own environment, pr-<number>: a short-lived copy of the stack that CI deploys and
 * tests for each push to the PR, and deletes when the PR is closed (.github/workflows/lambda.yml).
 */
export type PrEnvName = `pr-${number}`;
export type EnvName = (typeof ENV_NAMES)[number] | PrEnvName;
export const PR_ENV_PATTERN = /^pr-[1-9]\d*$/;
export const isPrEnv = (envName: string): envName is PrEnvName => PR_ENV_PATTERN.test(envName);

export const PROJECT_NAME = 'rollback-factory-demo';
/** This project's folder and stack name prefix: the stack is deploy-aws-lambda-<env>. */
export const STACK_PREFIX = 'deploy-aws-lambda';
/** The service's own name, like api-user for the API: the function is service-lambda-<env>. */
export const SERVICE_NAME = 'service-lambda';
/** Clients call this alias; only promotion and the rollback service move it. */
export const LIVE_ALIAS = 'live';
/** Every deploy points this alias at the newly published version; CI tests it before promoting. */
export const INTEGRATION_ALIAS = 'integration';

export interface EnvConfig {
  envName: EnvName;
  /**
   * A pull request's environment (pr-<number>): its errors alarm notifies nobody (there is no rollback
   * service for it, and the function is not registered in rollback-config.json).
   */
  pr: boolean;
  /** service-lambda-<env> */
  functionName: string;
  /** deploy-aws-lambda-<env> */
  stackName: string;
  /** Every other resource: rollback-factory-demo-<resource>-<env>. */
  resourceName: (resource: string) => string;
  /**
   * rollback-factory-demo-lambda-service-lambda-errors-<env>: the rollback service picks its Lambda
   * manager from the "lambda" type in the name (and must list it in its rollback-config.json).
   */
  errorsAlarmName: string;
  /** The rollback service's topic in this region (rollback-service), which the alarm publishes to. */
  rollbackTopicName: string;
  /** The rollback service's Lambda: deployment:sync and the manual rollbacks invoke it. */
  rollbackServiceFunctionName: string;
  /** The rollback service's version archive (metadata), read by versions:list. */
  versionsTableName: string;
  /**
   * The version `live` serves right now (from scripts/live-context.ts). When set, `cdk deploy`
   * leaves `live` there and only moves `integration` to the new version.
   */
  liveLambdaVersion?: string;
  /** Whether stateful resources survive stack deletion (none here since the archive moved to rollback-service). */
  retainData: boolean;
}

export interface ConfigOverrides {
  liveLambdaVersion?: string;
}

export function getConfig(envName: string | undefined, overrides: ConfigOverrides = {}): EnvConfig {
  if (!ENV_NAMES.includes(envName as (typeof ENV_NAMES)[number]) && !isPrEnv(envName ?? '')) {
    throw new Error(`Unknown env "${envName}". Pass -c env=<${ENV_NAMES.join('|')}|pr-<number>>`);
  }
  const liveLambdaVersion = overrides.liveLambdaVersion || undefined;
  if (liveLambdaVersion && !/^\d+$/.test(liveLambdaVersion)) {
    throw new Error(`liveLambdaVersion must be a published version number, got "${liveLambdaVersion}"`);
  }
  const resourceName = (resource: string) => `${PROJECT_NAME}-${resource}-${envName}`;

  return {
    envName: envName as EnvName,
    pr: isPrEnv(envName as string),
    functionName: `${SERVICE_NAME}-${envName}`,
    stackName: `${STACK_PREFIX}-${envName}`,
    resourceName,
    errorsAlarmName: resourceName(`lambda-${SERVICE_NAME}-errors`),
    rollbackTopicName: resourceName('rollback-notifications'),
    rollbackServiceFunctionName: resourceName('rollback-service'),
    versionsTableName: resourceName('lambda-archive'),
    liveLambdaVersion,
    retainData: envName === 'prod',
  };
}
