import * as cdk from 'aws-cdk-lib';
import { EnvConfig } from './config.js';
import { FrontendUserStack } from './frontend-user-stack.js';
import { FrontendAlarmsStack } from './frontend-alarms-stack.js';

/**
 * The two stacks of one environment. Cross-region references need both regions to be
 * concrete, so the main region is never left env-agnostic.
 */
export function createFrontendStacks(app: cdk.App, config: EnvConfig, env: { account?: string; region: string }) {
  const main = new FrontendUserStack(app, config.stackName, {
    config,
    env,
    crossRegionReferences: true,
    description: `${config.frontendName} static site served by CloudFront`,
  });
  const alarms = new FrontendAlarmsStack(app, config.alarmsStackName, {
    config,
    env: { account: env.account, region: config.alarmsRegion },
    crossRegionReferences: true,
    distributionId: main.distribution.distributionId,
    description: `${config.frontendName} CloudFront alarms and rollback (CloudFront metrics live in us-east-1)`,
  });
  // the alarms watch the distribution, so `cdk deploy --all` creates the main stack first
  alarms.addStackDependency(main);
  return { main, alarms };
}
