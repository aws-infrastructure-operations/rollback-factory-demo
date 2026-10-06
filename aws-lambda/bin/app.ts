#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { getConfig, PROJECT_NAME } from '../lib/config.js';
import { LambdaServiceStack } from '../lib/lambda-service-stack.js';

const app = new cdk.App();
const ctx = (key: string) => app.node.tryGetContext(key);
const config = getConfig(ctx('env') ?? process.env.LAMBDA_ENV ?? 'dev', {
  liveLambdaVersion: ctx('liveLambdaVersion'),
});

new LambdaServiceStack(app, config.stackName, {
  config,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: `${config.functionName} with integration-first deploys and automatic rollback`,
});

cdk.Tags.of(app).add('project', PROJECT_NAME);
cdk.Tags.of(app).add('environment', config.envName);
