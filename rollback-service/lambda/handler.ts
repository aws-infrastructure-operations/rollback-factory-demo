// The rollback service's Lambda: one function for every rollback manager, wired to AWS from the
// environment the stack sets. The router picks the manager from the alarm name (router.ts).
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { waitUntilFunctionUpdatedV2 } from '@aws-sdk/client-lambda';
import rollbackConfig from '../rollback-config.json';
import { ALARM_TYPES, EnvName } from '../lib/config.js';
import * as apigateway from './managers/apigateway/manager.js';
import * as cloudformation from './managers/cloudformation/manager.js';
import * as cloudfront from './managers/cloudfront/manager.js';
import { resolveRegistry } from './managers/lambda/registry.js';
import { createRollbackSystem } from './managers/lambda/rollback.js';
import { scopedClientsFactory } from './managers/lambda/scoped.js';
import { createRouter, type ServiceEvent } from './router.js';
import { createTargetReader } from './targets.js';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
};
const minutes = (name: string, fallback: number) => Number(process.env[name] ?? fallback) * 60_000;

const ENV_NAME = env('ENV_NAME') as EnvName;
const targets = createTargetReader();

const lambdaManager = createRollbackSystem(
  {
    cloudwatch: new CloudWatchClient({}),
    scopedClients: scopedClientsFactory({
      roleArn: env('LAMBDA_ROLLBACK_ROLE_ARN'),
      functionArnPrefix: env('FUNCTION_ARN_PREFIX'),
      tableArn: env('VERSIONS_TABLE_ARN'),
      bucketName: env('ARTIFACTS_BUCKET_NAME'),
    }),
    fetch,
    waitForUpdate: async (lambda, functionName) => {
      await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 60 }, { FunctionName: functionName });
    },
    now: Date.now,
  },
  {
    tableName: env('VERSIONS_TABLE_NAME'),
    bucketName: env('ARTIFACTS_BUCKET_NAME'),
    registry: resolveRegistry(rollbackConfig, ENV_NAME),
    cooldownMs: minutes('ROLLBACK_COOLDOWN_MINUTES', 3),
    stableAfterMs: minutes('STABLE_AFTER_MINUTES', 5),
    liveErrorsLookbackMs: minutes('LIVE_ERRORS_LOOKBACK_MINUTES', 5),
  },
);

const cloudformationDeps: cloudformation.CloudFormationDeps = {
  cfn: new CloudFormationClient({}),
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  table: env('STACK_TEMPLATES_TABLE_NAME'),
  region: env('AWS_REGION'),
};

const route = createRouter(ENV_NAME, {
  apigateway: async (alarm, envName) =>
    apigateway.handleAlarm(await targets.get(ALARM_TYPES.apigateway.stack(envName)), alarm),
  apigatewayRestore: async (req, envName) =>
    apigateway.restore(await targets.get(ALARM_TYPES.apigateway.stack(envName)), req),
  cloudfront: async (alarm, envName) =>
    cloudfront.handleAlarm(await targets.get(ALARM_TYPES.cloudfront.stack(envName)), alarm),
  cloudfrontRestore: async (req, envName) =>
    cloudfront.restore(await targets.get(ALARM_TYPES.cloudfront.stack(envName)), req),
  cloudformationRestore: async (req, envName) => cloudformation.restore(cloudformationDeps, envName, req),
  lambda: async (event) => (await lambdaManager(event)) as unknown[],
});

export const handler = async (event: ServiceEvent) => {
  targets.clear();
  const started = Date.now();
  // runs the dashboard started carry an operation id: with the duration, the dashboard estimates
  // how long the next run of that kind takes (deploy-aws-cloudfront operations.ts)
  const run = () => ({
    ...('operationId' in event && typeof event.operationId === 'string' && { operationId: event.operationId }),
    durationMs: Date.now() - started,
  });
  try {
    const result = await route(event);
    console.log(JSON.stringify({ msg: 'result', ...run(), result }));
    return result;
  } catch (err) {
    console.error(JSON.stringify({ msg: 'failed', ...run(), error: (err as Error).message }));
    throw err;
  }
};
