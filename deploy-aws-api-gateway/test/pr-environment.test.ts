import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ApiUserStack } from '../lib/api-user-stack.js';
import { getConfig, isPrEnv } from '../lib/config.js';

const synth = (env: string) => Template.fromStack(new ApiUserStack(new cdk.App(), `Test-${env}`, { config: getConfig(env) }));

test('accepts a pull request\'s environment pr-<number>, and nothing like it', () => {
  assert.ok(isPrEnv('pr-123'));
  for (const env of ['pr-', 'pr-0', 'pr-12a', 'pr-1 ', 'PR-1', 'pr--1']) {
    assert.ok(!isPrEnv(env), env);
    assert.throws(() => getConfig(env), /Unknown env/, env);
  }
  assert.equal(getConfig('dev').pr, false);
});

test('names a pull request\'s resources after its number and keeps nothing', () => {
  const config = getConfig('pr-123');
  assert.equal(config.pr, true);
  assert.equal(config.apiName, 'api-user-pr-123');
  assert.equal(config.stackName, 'deploy-aws-api-gateway-pr-123');
  assert.equal(config.backends.users.functionName, 'rollback-factory-demo-api-users-pr-123');
  assert.equal(config.retainData, false);
});

test('maps a pull request\'s stages on dev\'s API domain under user-pr-<n>', () => {
  assert.deepEqual(getConfig('pr-123').customDomain, {
    domainName: 'api.dev.rollback.ionuteliantudor.com',
    basePaths: { stage: 'user-pr-123/v1', integration: 'user-pr-123/integration' },
  });
  const t = synth('pr-123');
  t.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 2);
  t.hasResourceProperties('AWS::ApiGatewayV2::ApiMapping', {
    DomainName: 'api.dev.rollback.ionuteliantudor.com',
    ApiMappingKey: 'user-pr-123/integration',
  });
  assert.equal(t.findOutputs('*').IntegrationCustomDomainUrl.Value,
    'https://api.dev.rollback.ionuteliantudor.com/user-pr-123/integration/');
});

test('a pull request\'s alarms notify nobody; dev\'s notify the rollback service', () => {
  const actions = (env: string) => Object.values(synth(env).findResources('AWS::CloudWatch::Alarm'))
    .map((alarm: any) => alarm.Properties.AlarmActions);
  assert.ok(actions('pr-123').every((a) => a === undefined));
  assert.ok(actions('dev').every((a) => a?.length === 1));
});

test('a pull request\'s stack relies on dev\'s account-level CloudWatch role', () => {
  synth('pr-123').resourceCountIs('AWS::ApiGateway::Account', 0);
  synth('dev').resourceCountIs('AWS::ApiGateway::Account', 1);
});

test('a pull request\'s stack retains nothing when it is deleted', () => {
  const retained = Object.entries(synth('pr-123').toJSON().Resources as Record<string, any>)
    .filter(([, r]) => r.DeletionPolicy === 'Retain')
    .map(([id, r]) => `${id} (${r.Type})`);
  // Lambda versions and API deployments are kept on purpose (live / v1 may still serve an older one);
  // they are deleted with their function and their API
  assert.deepEqual(retained.filter((r) => !/AWS::Lambda::Version|AWS::ApiGateway::Deployment/.test(r)), []);
});
