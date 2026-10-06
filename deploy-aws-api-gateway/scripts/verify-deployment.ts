/**
 * Marks the deployment the stage currently serves as verified (run it after the
 * integration tests passed). The rollback Lambda only rolls back to verified
 * deployments, so an untested or broken one is never restored.
 *
 * Usage: npx tsx scripts/verify-deployment.ts --env dev
 */
import { getStageDeploymentId, listDeployments, markVerified } from '../lambda/shared/deployments.js';
import { log, parseCli, run } from './lib/cli.js';
import { deploymentTarget, requireStackOutputs } from './lib/stack.js';

run(async () => {
  const { config } = parseCli();
  const target = deploymentTarget(config, await requireStackOutputs(config));
  const live = await getStageDeploymentId(target.restApiId, target.stageName);
  const [latest] = await listDeployments(target.table, target.apiName, 1);

  // Only the latest record may be verified, and only if the stage really serves it -
  // otherwise the tests passed against something else.
  if (!latest || latest.deploymentId !== live) {
    throw new Error(
      `Stage ${target.stageName} serves deployment ${live}, but the latest record is `
      + `${latest ? `${latest.deploymentId} (${latest.deployedAt})` : 'missing'} - record the deployment first`,
    );
  }
  await markVerified(target.table, latest);
  log(`Verified deployment ${latest.deploymentId} of ${config.apiName} (${latest.deployedAt}, ${latest.source})`);
});
