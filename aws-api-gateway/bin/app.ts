#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { getConfig, PROJECT_NAME } from '../lib/config.js';
import { ApiUserStack } from '../lib/api-user-stack.js';

const app = new cdk.App();
const ctx = (key: string) => app.node.tryGetContext(key);
const config = getConfig(ctx('env') ?? process.env.API_ENV ?? 'dev', {
  alarmNotifications: ctx('alarmNotifications'),
  alarmEmail: ctx('alarmEmail'),
  rollbackWindowMinutes: ctx('rollbackWindowMinutes'),
  chaosFailureRate: ctx('chaosFailureRate'),
});

new ApiUserStack(app, config.stackName, {
  config,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: `${config.apiName} REST API with Cognito authorizer`,
});

cdk.Tags.of(app).add('project', PROJECT_NAME);
cdk.Tags.of(app).add('environment', config.envName);
