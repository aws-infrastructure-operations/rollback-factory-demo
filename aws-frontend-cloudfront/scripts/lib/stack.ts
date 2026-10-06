import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { EnvConfig } from '../../lib/config.js';
import { createDeploymentStore } from '../../lambda/shared/deployments.js';

/** Outputs of rollback-factory-demo-frontend-<env>. */
export interface FrontendOutputs {
  DistributionId: string;
  DistributionDomainName: string;
  SiteUrl: string;
  SiteBucketName: string;
  DeploymentsBucketName: string;
  DeploymentsTableName: string;
}

/** The outputs of rollback-factory-demo-<env> (the api-user stack) a release is built with. */
export interface ApiOutputs {
  ApiUrl: string;
  UserPoolId: string;
  UserPoolClientId: string;
}

const cfn = new CloudFormationClient({});

/** Returns the deployed stack's outputs, or undefined if the stack doesn't exist yet. */
async function getOutputs(stackName: string): Promise<Record<string, string> | undefined> {
  try {
    const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    return Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
  } catch (err) {
    if (err instanceof Error && /does not exist/.test(err.message)) return undefined;
    throw err;
  }
}

async function requireOutputs<T>(stackName: string, keys: readonly (keyof T & string)[], hint: string): Promise<T> {
  const outputs = await getOutputs(stackName);
  if (!outputs) throw new Error(`Stack ${stackName} is not deployed in ${await cfn.config.region()}. ${hint}`);
  const missing = keys.filter((key) => !outputs[key]);
  if (missing.length) throw new Error(`Stack ${stackName} has no output ${missing.join(', ')}. ${hint}`);
  return outputs as T;
}

export const getFrontendOutputs = async (config: EnvConfig) =>
  (await getOutputs(config.stackName)) as Partial<FrontendOutputs> | undefined;

export const requireFrontendOutputs = (config: EnvConfig) =>
  requireOutputs<FrontendOutputs>(
    config.stackName,
    ['DistributionId', 'DistributionDomainName', 'SiteUrl', 'SiteBucketName', 'DeploymentsBucketName', 'DeploymentsTableName'],
    `Deploy it first: npx cdk deploy --all -c env=${config.envName}`,
  );

export const requireApiOutputs = (config: EnvConfig) =>
  requireOutputs<ApiOutputs>(
    config.apiStackName,
    ['ApiUrl', 'UserPoolId', 'UserPoolClientId'],
    'Deploy the API first (aws-api-gateway).',
  );

export const deploymentStore = (config: EnvConfig, outputs: FrontendOutputs) =>
  createDeploymentStore({ table: outputs.DeploymentsTableName, frontendName: config.frontendName });
