/**
 * Promotes what the integration stage serves to stage v1, after the integration tests
 * passed against it: moves each backend's `live` alias to its `integration` alias's
 * version and points v1 at the integration stage's deployment.
 * Record it afterwards with `npm run deployment:record`, and sync the rollback service's
 * version archive (CI does both).
 *
 * Usage: npx tsx scripts/promote-deployment.ts --env dev
 */
import { APIGatewayClient, UpdateStageCommand } from '@aws-sdk/client-api-gateway';
import { LambdaClient, UpdateAliasCommand } from '@aws-sdk/client-lambda';
import { getAliasVersion, getStageDeploymentId } from '../lambda/shared/deployments.js';
import { log, parseCli, run } from './lib/cli.js';
import { requireStackOutputs } from './lib/stack.js';

run(async () => {
  const { config } = parseCli();
  const outputs = await requireStackOutputs(config);
  const restApiId = outputs.ApiId;
  const lambda = new LambdaClient({});

  const [testedDeployment, liveDeployment] = await Promise.all([
    getStageDeploymentId(restApiId, config.integrationStageName),
    getStageDeploymentId(restApiId, config.stageName),
  ]);

  let changed = false;
  for (const { functionName } of Object.values(config.backends)) {
    const [testedVersion, liveVersion] = await Promise.all([
      getAliasVersion(functionName, 'integration'),
      getAliasVersion(functionName, 'live'),
    ]);
    if (!testedVersion) throw new Error(`${functionName} has no "integration" alias - deploy the stack first`);
    if (testedVersion === liveVersion) continue;
    await lambda.send(new UpdateAliasCommand({ FunctionName: functionName, Name: 'live', FunctionVersion: testedVersion }));
    log(`${functionName}: alias live ${liveVersion ?? '(none)'} -> version ${testedVersion}`);
    changed = true;
  }
  if (testedDeployment !== liveDeployment) {
    await new APIGatewayClient({}).send(new UpdateStageCommand({
      restApiId,
      stageName: config.stageName,
      patchOperations: [{ op: 'replace', path: '/deploymentId', value: testedDeployment }],
    }));
    log(`${config.apiName}: stage ${config.stageName} ${liveDeployment} -> deployment ${testedDeployment}`);
    changed = true;
  }
  if (!changed) log(`${config.apiName}/${config.stageName} already serves what was tested - nothing to promote`);
});
