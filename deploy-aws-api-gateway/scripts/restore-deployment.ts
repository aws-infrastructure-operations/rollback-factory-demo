/**
 * Restores a recorded deployment you choose: the rollback service (its API Gateway manager) re-imports its
 * OpenAPI spec and redeploys the stage, then records a "restore". Use it to
 * recover when the live API is in a bad state. The restored deployment is not
 * verified until the integration tests pass again (deployment:verify).
 *
 * Usage: npx tsx scripts/restore-deployment.ts --env dev --to 2026-10-06T11:38:01.784Z [--reason "..."]
 *        (the deployedAt value from `npm run deployment:list`)
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { log, parseCli, run } from './lib/cli.js';

run(async () => {
  const { config, values } = parseCli(['to', 'reason'] as const);
  if (!values.to) throw new Error('Pass --to <deployedAt> (see npm run deployment:list)');

  const actor = process.env.GITHUB_ACTOR ? `github:${process.env.GITHUB_ACTOR}` : 'manual';
  log(`Restoring ${config.apiName} to the deployment recorded at ${values.to} (via ${config.rollbackServiceFunctionName})`);
  const res = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: config.rollbackServiceFunctionName,
    Payload: new TextEncoder().encode(JSON.stringify({
      type: 'restore', manager: 'apigateway', deployedAt: values.to, reason: values.reason, actor,
    })),
  }));
  const payload = res.Payload ? new TextDecoder().decode(res.Payload) : '';
  if (res.FunctionError) throw new Error(`Restore failed: ${payload}`);
  process.stdout.write(`${payload}\n`);
});
