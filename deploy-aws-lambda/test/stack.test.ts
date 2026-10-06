import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ConfigOverrides, getConfig } from '../lib/config.js';
import { LambdaServiceStack } from '../lib/lambda-service-stack.js';

const synth = (env = 'dev', overrides: ConfigOverrides = {}) => {
  const app = new cdk.App();
  return Template.fromStack(new LambdaServiceStack(app, 'Test', {
    config: getConfig(env, overrides),
    versionDescription: 'abc1234 Test commit',
    env: { account: '123456789012', region: 'eu-central-1' },
  }));
};

const aliases = (t: Template) => Object.fromEntries(Object.values(t.findResources('AWS::Lambda::Alias'))
  .map((a: any) => [a.Properties.Name, a.Properties.FunctionVersion]));

test('integration always gets the new version; live too on the first deploy', () => {
  const { integration, live } = aliases(synth());
  assert.match(JSON.stringify(integration), /ServiceFunctionCurrentVersion/);
  assert.deepEqual(live, integration);
});

test('live stays on -c liveLambdaVersion while integration gets the new version', () => {
  const { integration, live } = aliases(synth('dev', { liveLambdaVersion: '7' }));
  assert.match(JSON.stringify(integration), /ServiceFunctionCurrentVersion/);
  assert.equal(live, '7');
});

test('keeps published versions and describes them with the commit', () => {
  synth().hasResource('AWS::Lambda::Version', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({ Description: 'abc1234 Test commit' }),
  });
});

test('names the function per environment; no rollback function of its own', () => {
  const t = synth('staging');
  t.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'service-lambda-staging', Runtime: 'nodejs24.x' });
  t.resourceCountIs('AWS::Lambda::Function', 1);
  t.resourceCountIs('AWS::SNS::Topic', 0);
  t.resourceCountIs('AWS::Events::Rule', 0);
  t.resourceCountIs('AWS::DynamoDB::GlobalTable', 0);
});

test('alarms on errors of live and $LATEST only, never on the integration alias', () => {
  const t = synth();
  const [alarm] = Object.values(t.findResources('AWS::CloudWatch::Alarm')) as any[];
  assert.equal(alarm.Properties.AlarmName, 'rollback-factory-demo-lambda-service-lambda-errors-dev');
  assert.equal(alarm.Properties.Threshold, 1);
  const resources = alarm.Properties.Metrics.filter((m: any) => m.MetricStat)
    .map((m: any) => m.MetricStat.Metric.Dimensions.find((d: any) => d.Name === 'Resource').Value).sort();
  assert.deepEqual(resources, ['service-lambda-dev', 'service-lambda-dev:$LATEST', 'service-lambda-dev:live']);
  assert.ok(!JSON.stringify(alarm).includes(':integration'));
  // publishes to the rollback service's topic
  assert.match(JSON.stringify(alarm.Properties.AlarmActions), /:rollback-factory-demo-rollback-notifications-dev/);
});

test('prefixes export names, so they never clash with the API or frontend stacks', () => {
  for (const [name, output] of Object.entries(synth().findOutputs('*'))) {
    assert.match((output as any).Export.Name, /^rollback-factory-demo-lambda-/, name);
  }
});
