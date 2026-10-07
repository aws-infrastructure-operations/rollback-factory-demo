import * as cdk from 'aws-cdk-lib';
import { EnvConfig } from './config.js';
import { FrontendCertificateStack } from './frontend-certificate-stack.js';
import { FrontendUserStack } from './frontend-user-stack.js';
import { FrontendAlarmsStack } from './frontend-alarms-stack.js';

/**
 * The three stacks of one environment (certificate, main, alarms). Cross-region references need both regions to be
 * concrete, so the main region is never left env-agnostic.
 */
export function createFrontendStacks(app: cdk.App, config: EnvConfig, env: { account?: string; region: string }) {
  // us-east-1 first: the distributions serve their domains with this certificate
  const certificate = new FrontendCertificateStack(app, config.certificateStackName, {
    config,
    env: { account: env.account, region: config.alarmsRegion },
    crossRegionReferences: true,
    description: `TLS certificate of ${config.domains.site} and ${config.domains.integration} (CloudFront takes us-east-1 certificates only)`,
  });
  const main = new FrontendUserStack(app, config.stackName, {
    config,
    env,
    crossRegionReferences: true,
    certificate: certificate.certificate,
    description: `${config.frontendName} static site served by CloudFront`,
  });
  main.addStackDependency(certificate);
  const alarms = new FrontendAlarmsStack(app, config.alarmsStackName, {
    config,
    env: { account: env.account, region: config.alarmsRegion },
    crossRegionReferences: true,
    distributionId: main.distribution.distributionId,
    description: `${config.frontendName} CloudFront alarms and rollback (CloudFront metrics live in us-east-1)`,
  });
  // the alarms watch the distribution, so `cdk deploy --all` creates the main stack first
  alarms.addStackDependency(main);
  return { certificate, main, alarms };
}
