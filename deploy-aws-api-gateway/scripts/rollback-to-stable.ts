/**
 * Rolls stage v1 back to the latest stable deployment after the integration tests failed on a new one
 * (deploy-test-rollback.yml): marks the failed deployment as rolled back, so neither this nor an alarm
 * ever restores it, then has the rollback service re-import the stable deployment's OpenAPI spec from
 * S3 and redeploy v1. The restored spec calls each backend's `live` alias. Run the integration tests
 * again and deployment:verify afterwards: the restore is recorded unverified.
 *
 * Prints { from, to, deploymentId } as JSON.
 *
 * Usage: npx tsx scripts/rollback-to-stable.ts --env dev --failed <deployedAt> [--reason "..."]
 *        (the deployedAt that deployment:record printed for the failed deployment)
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { claimRollback, getDeployment, listDeployments } from '../lambda/shared/deployments.js';
import { log, parseCli, run } from './lib/cli.js';
import { latestStable } from './lib/stable.js';
import { deploymentTarget, requireStackOutputs } from './lib/stack.js';

run(async () => {
  const { config, values } = parseCli(['failed', 'reason']);
  if (!values.failed) throw new Error('Pass --failed <deployedAt> (printed by deployment:record)');
  const target = deploymentTarget(config, await requireStackOutputs(config));

  const failed = await getDeployment(target.table, target.apiName, values.failed);
  if (!failed) throw new Error(`No deployment of ${config.apiName} recorded at ${values.failed}`);
  // false: an alarm got there first; v1 still goes to the latest stable deployment below
  if (await claimRollback(target.table, failed)) log(`Marked ${failed.deployedAt} (${failed.deploymentId}) as rolled back`);
  else log(`${failed.deployedAt} was already marked as rolled back (by an alarm?)`);

  const to = latestStable(await listDeployments(target.table, target.apiName, 100), failed.deployedAt);
  if (!to) throw new Error(`${config.apiName} has no stable deployment before ${failed.deployedAt} to roll back to`);
  log(`Rolling ${config.apiName}/${target.stageName} back to ${to.deployedAt} (${to.deploymentId}, verified ${to.verifiedAt})`);

  const actor = process.env.GITHUB_ACTOR ? `github:${process.env.GITHUB_ACTOR}` : 'manual';
  const reason = values.reason ?? `integration tests failed on ${failed.deployedAt}`;
  const res = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: config.rollbackServiceFunctionName,
    Payload: new TextEncoder().encode(JSON.stringify({
      type: 'restore', manager: 'apigateway', deployedAt: to.deployedAt, reason, actor,
    })),
  }));
  const payload = res.Payload ? new TextDecoder().decode(res.Payload) : '';
  if (res.FunctionError) throw new Error(`Restore failed: ${payload}`);
  const restored = JSON.parse(payload) as { deploymentId?: string };
  process.stdout.write(`${JSON.stringify({ from: failed.deployedAt, to: to.deployedAt, deploymentId: restored.deploymentId })}\n`);
});
