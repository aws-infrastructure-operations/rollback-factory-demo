/**
 * Promotes what the integration stage serves to stage v1, after the integration tests
 * passed against it: moves the handler's `live` alias to the `integration` alias's
 * version and points v1 at the integration stage's deployment.
 * Record it afterwards with `npm run deployment:record`.
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
  const handler = config.resourceName('handler');

  const [testedDeployment, liveDeployment, testedVersion, liveVersion] = await Promise.all([
    getStageDeploymentId(restApiId, config.integrationStageName),
    getStageDeploymentId(restApiId, config.stageName),
    getAliasVersion(handler, 'integration'),
    getAliasVersion(handler, 'live'),
  ]);
  if (!testedVersion) throw new Error(`${handler} has no "integration" alias - deploy the stack first`);

  if (testedVersion !== liveVersion) {
    await new LambdaClient({}).send(new UpdateAliasCommand({
      FunctionName: handler,
      Name: 'live',
      FunctionVersion: testedVersion,
    }));
    log(`${handler}: alias live ${liveVersion ?? '(none)'} -> version ${testedVersion}`);
  }
  if (testedDeployment !== liveDeployment) {
    await new APIGatewayClient({}).send(new UpdateStageCommand({
      restApiId,
      stageName: config.stageName,
      patchOperations: [{ op: 'replace', path: '/deploymentId', value: testedDeployment }],
    }));
    log(`${config.apiName}: stage ${config.stageName} ${liveDeployment} -> deployment ${testedDeployment}`);
  }
  if (testedVersion === liveVersion && testedDeployment === liveDeployment) {
    log(`${config.apiName}/${config.stageName} already serves what was tested - nothing to promote`);
  }
});
