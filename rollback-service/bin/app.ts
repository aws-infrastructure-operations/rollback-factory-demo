#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EDGE_REGION, getConfig, MAIN_REGION_FALLBACK, PROJECT_NAME } from '../lib/config.js';
import { RollbackServiceEdgeStack, RollbackServiceStack } from '../lib/rollback-service-stack.js';

const app = new cdk.App();
const ctx = (key: string) => app.node.tryGetContext(key);
const config = getConfig(ctx('env') ?? process.env.ROLLBACK_ENV ?? 'dev', { alarmEmail: ctx('alarmEmail') });
const account = process.env.CDK_DEFAULT_ACCOUNT;

// us-east-1 first: the main stack subscribes the rollback Lambda to its topic.
const edge = new RollbackServiceEdgeStack(app, config.edgeStackName, {
  config,
  env: { account, region: EDGE_REGION },
  description: `Topic for the CloudFront rollback alarms of ${config.envName} (CloudFront metrics live in us-east-1)`,
});
const main = new RollbackServiceStack(app, config.stackName, {
  config,
  env: { account, region: process.env.CDK_DEFAULT_REGION ?? MAIN_REGION_FALLBACK },
  description: `One rollback Lambda for the API Gateway, CloudFront and Lambda deployments of ${config.envName}`,
});
main.addStackDependency(edge);

cdk.Tags.of(app).add('project', PROJECT_NAME);
cdk.Tags.of(app).add('environment', config.envName);
