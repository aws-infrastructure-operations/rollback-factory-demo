// Lambda entry point: wires the rollback system to AWS from the environment the stack sets.
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { waitUntilFunctionUpdatedV2 } from '@aws-sdk/client-lambda';
import rollbackConfig from '../../rollback-config.json';
import { resolveRegistry } from './registry.js';
import { createRollbackSystem, type RollbackEvent } from './rollback.js';
import { scopedClientsFactory } from './scoped.js';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
};
const minutes = (name: string, fallback: number) => Number(process.env[name] ?? fallback) * 60_000;

const handle = createRollbackSystem(
  {
    cloudwatch: new CloudWatchClient({}),
    scopedClients: scopedClientsFactory({
      roleArn: env('ROLLBACK_ROLE_ARN'),
      functionArnPrefix: env('FUNCTION_ARN_PREFIX'),
      tableArn: env('TABLE_ARN'),
      bucketName: env('BUCKET_NAME'),
    }),
    fetch,
    waitForUpdate: async (lambda, functionName) => {
      await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 60 }, { FunctionName: functionName });
    },
    now: Date.now,
  },
  {
    tableName: env('TABLE_NAME'),
    bucketName: env('BUCKET_NAME'),
    registry: resolveRegistry(rollbackConfig, env('ENV_NAME')),
    cooldownMs: minutes('ROLLBACK_COOLDOWN_MINUTES', 3),
    stableAfterMs: minutes('STABLE_AFTER_MINUTES', 5),
    liveErrorsLookbackMs: minutes('LIVE_ERRORS_LOOKBACK_MINUTES', 5),
  },
);

export const handler = (event: RollbackEvent) => handle(event);
