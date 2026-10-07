#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PROJECT_NAME, STACK_NAME, ZONE_NAME } from '../lib/config.js';
import { DnsStack } from '../lib/dns-stack.js';

const app = new cdk.App();
// A hosted zone is global: the region only says where the stack itself lives.
new DnsStack(app, STACK_NAME, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: `Route 53 hosted zone ${ZONE_NAME}, shared by every environment's CloudFront sites`,
});

cdk.Tags.of(app).add('project', PROJECT_NAME);
