import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { EnvConfig } from '../../lib/config.js';
import { DeploymentTarget } from '../../lambda/shared/deployments.js';

export interface StackOutputs {
  ApiId: string;
  ApiUrl: string;
  StageName: string;
  UserPoolId: string;
  UserPoolClientId: string;
  SpecBucketName: string;
  DeploymentsTableName: string;
  AlarmTopicArn: string;
  Alarm4xxName: string;
  Alarm5xxName: string;
  RollbackFunctionName: string;
  LambdaErrorsAlarmName: string;
  AccessLogGroupName: string;
}

const cfn = new CloudFormationClient({});

export const awsRegion = () => cfn.config.region();

/** Returns the deployed stack outputs, or undefined if the stack doesn't exist yet. */
export async function getStackOutputs(config: EnvConfig): Promise<StackOutputs | undefined> {
  try {
    const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: config.stackName }));
    const outputs = Object.fromEntries(
      (Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]),
    );
    return outputs as unknown as StackOutputs;
  } catch (err) {
    if (err instanceof Error && /does not exist/.test(err.message)) return undefined;
    throw err;
  }
}

export async function requireStackOutputs(config: EnvConfig): Promise<StackOutputs> {
  const outputs = await getStackOutputs(config);
  if (!outputs) throw new Error(`Stack ${config.stackName} is not deployed`);
  return outputs;
}

export const deploymentTarget = (config: EnvConfig, outputs: StackOutputs): DeploymentTarget => ({
  apiName: config.apiName,
  restApiId: outputs.ApiId,
  stageName: outputs.StageName,
  specBucket: outputs.SpecBucketName,
  table: outputs.DeploymentsTableName,
});
