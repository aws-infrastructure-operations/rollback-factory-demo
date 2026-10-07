import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { API_DOMAIN_ENVS as DNS_API_DOMAIN_ENVS, apiDomain as dnsApiDomain, ZONE_NAME as DNS_ZONE_NAME } from '../../deploy-aws-dns/lib/config.js';
import { ApiUserStack } from '../lib/api-user-stack.js';
import { API_DOMAIN_ENVS, apiDomain, getConfig, ZONE_NAME } from '../lib/config.js';

const synth = (env: string) => Template.fromStack(new ApiUserStack(new cdk.App(), `Test-${env}`, { config: getConfig(env) }));

test('names the API domains like deploy-aws-dns: dev with a prefix, prod without', () => {
  assert.equal(ZONE_NAME, DNS_ZONE_NAME);
  assert.deepEqual([...API_DOMAIN_ENVS], [...DNS_API_DOMAIN_ENVS]);
  for (const env of ['dev', 'prod']) assert.equal(apiDomain(env), dnsApiDomain(env), env);
  assert.equal(apiDomain('dev'), 'api.dev.rollback.ionuteliantudor.com');
  assert.equal(apiDomain('prod'), 'api.rollback.ionuteliantudor.com');
});

test('maps stage v1 on user/v1 and the integration stage on user/integration', () => {
  for (const env of ['dev', 'prod']) {
    const t = synth(env);
    t.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 2);
    for (const [key, stage] of [['user/v1', 'v1'], ['user/integration', 'integration']]) {
      t.hasResourceProperties('AWS::ApiGatewayV2::ApiMapping', {
        DomainName: apiDomain(env),
        ApiMappingKey: key,
        ApiId: { Ref: Match.stringLikeRegexp('^Api') },
        Stage: { Ref: Match.stringLikeRegexp(stage === 'v1' ? '^ApiDeploymentStagev1' : '^IntegrationStage') },
      });
    }
  }
});

test('outputs the custom domain URL of each stage', () => {
  const outputs = synth('dev').findOutputs('*');
  assert.equal(outputs.CustomDomainUrl.Value, 'https://api.dev.rollback.ionuteliantudor.com/user/v1/');
  assert.equal(outputs.IntegrationCustomDomainUrl.Value, 'https://api.dev.rollback.ionuteliantudor.com/user/integration/');
  // the execute-api URLs stay: CI and the scripts use them
  assert.ok(outputs.ApiUrl && outputs.IntegrationApiUrl);
});

test('environments without an API domain get no mappings', () => {
  const t = synth('testing');
  t.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 0);
  assert.equal(t.findOutputs('CustomDomainUrl').CustomDomainUrl, undefined);
});
