#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { API_DOMAINS_STACK_NAME, PROJECT_NAME, STACK_NAME, ZONE_NAME } from '../lib/config.js';
import { ApiDomainsStack } from '../lib/api-domains-stack.js';
import { DnsStack } from '../lib/dns-stack.js';

const app = new cdk.App();
// A hosted zone is global: the region only says where the stack itself lives.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const dns = new DnsStack(app, STACK_NAME, {
  env,
  description: `Route 53 hosted zone ${ZONE_NAME}, shared by every environment's sites and APIs`,
});
// The API domains must be in the APIs' region: the workflow deploys with vars.AWS_REGION, like the APIs.
new ApiDomainsStack(app, API_DOMAINS_STACK_NAME, {
  env,
  zone: dns.zone,
  description: `API Gateway custom domains api.<env>.${ZONE_NAME}, shared by every API of an environment`,
});

cdk.Tags.of(app).add('project', PROJECT_NAME);
