#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DEFAULT_REGION, getConfig, PROJECT_NAME } from '../lib/config.js';
import { createFrontendStacks } from '../lib/frontend-app.js';

const app = new cdk.App();
const ctx = (key: string) => app.node.tryGetContext(key);
const config = getConfig(ctx('env') ?? process.env.FRONTEND_ENV ?? 'dev', {
  alarmNotifications: ctx('alarmNotifications'),
  rollbackWindowMinutes: ctx('rollbackWindowMinutes'),
  liveReleaseId: ctx('liveReleaseId'),
  integrationReleaseId: ctx('integrationReleaseId'),
});

createFrontendStacks(app, config, {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? DEFAULT_REGION,
});

cdk.Tags.of(app).add('project', PROJECT_NAME);
cdk.Tags.of(app).add('environment', config.envName);
