import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { ALARMS_REGION, EnvConfig } from '../../lib/config.js';
import { createDeploymentStore } from '../../lambda/shared/deployments.js';

/** Outputs of rollback-factory-demo-frontend-<env>. */
export interface FrontendOutputs {
  DistributionId: string;
  DistributionDomainName: string;
  SiteUrl: string;
  IntegrationDistributionId: string;
  IntegrationSiteUrl: string;
  SiteBucketName: string;
  DeploymentsBucketName: string;
  DeploymentsTableName: string;
}

/** Outputs of rollback-factory-demo-frontend-alarms-<env> (us-east-1). */
export interface AlarmsOutputs {
  AlarmTopicArn: string;
  Alarm4xxName: string;
  Alarm5xxName: string;
  RollbackFunctionName: string;
}

const cfn = new CloudFormationClient({});
const cfnAlarmsRegion = new CloudFormationClient({ region: ALARMS_REGION });

/** Returns the deployed stack's outputs, or undefined if the stack doesn't exist yet. */
async function getOutputs(stackName: string, client = cfn): Promise<Record<string, string> | undefined> {
  try {
    const { Stacks } = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    return Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
  } catch (err) {
    if (err instanceof Error && /does not exist/.test(err.message)) return undefined;
    throw err;
  }
}

async function requireOutputs<T>(
  stackName: string,
  keys: readonly (keyof T & string)[],
  hint: string,
  client = cfn,
): Promise<T> {
  const outputs = await getOutputs(stackName, client);
  if (!outputs) throw new Error(`Stack ${stackName} is not deployed in ${await client.config.region()}. ${hint}`);
  const missing = keys.filter((key) => !outputs[key]);
  if (missing.length) throw new Error(`Stack ${stackName} has no output ${missing.join(', ')}. ${hint}`);
  return outputs as T;
}

export const getFrontendOutputs = async (config: EnvConfig) =>
  (await getOutputs(config.stackName)) as Partial<FrontendOutputs> | undefined;

export const requireFrontendOutputs = (config: EnvConfig) =>
  requireOutputs<FrontendOutputs>(
    config.stackName,
    [
      'DistributionId', 'DistributionDomainName', 'SiteUrl', 'IntegrationDistributionId', 'IntegrationSiteUrl',
      'SiteBucketName', 'DeploymentsBucketName', 'DeploymentsTableName',
    ],
    `Deploy it first: npx cdk deploy --all -c env=${config.envName}`,
  );

export const requireAlarmsOutputs = (config: EnvConfig) =>
  requireOutputs<AlarmsOutputs>(
    config.alarmsStackName,
    ['AlarmTopicArn', 'Alarm4xxName', 'Alarm5xxName', 'RollbackFunctionName'],
    `Deploy it first: npx cdk deploy --all -c env=${config.envName}`,
    cfnAlarmsRegion,
  );


export const deploymentStore = (config: EnvConfig, outputs: FrontendOutputs) =>
  createDeploymentStore({ table: outputs.DeploymentsTableName, frontendName: config.frontendName });

/**
 * Which distribution a script acts on: `live` is frontend-user-<env> (what clients use, what
 * gets recorded and rolled back), `integration` is frontend-user-<env>-integration (where CI
 * tests a release before it goes live).
 */
export type Target = 'live' | 'integration';

export function parseTarget(value: string | undefined): Target {
  if (value === undefined || value === 'live' || value === 'integration') return value ?? 'live';
  throw new Error(`--target must be live or integration, got "${value}"`);
}

export const targetDistribution = (config: EnvConfig, outputs: FrontendOutputs, target: Target) => (target === 'live'
  ? { name: config.frontendName, distributionId: outputs.DistributionId, siteUrl: outputs.SiteUrl }
  : { name: config.integrationName, distributionId: outputs.IntegrationDistributionId, siteUrl: outputs.IntegrationSiteUrl });
