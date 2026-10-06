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

test('names the functions per environment', () => {
  const t = synth('staging');
  t.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'service-lambda-staging', Runtime: 'nodejs24.x' });
  t.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'rollback-factory-demo-lambda-rollback-staging',
    Timeout: 120,
    MemorySize: 512,
    Environment: { Variables: Match.objectLike({ ENV_NAME: 'staging', ROLLBACK_COOLDOWN_MINUTES: '3' }) },
  });
});

test('alarms on errors of live and $LATEST only, never on the integration alias', () => {
  const t = synth();
  const [alarm] = Object.values(t.findResources('AWS::CloudWatch::Alarm')) as any[];
  assert.equal(alarm.Properties.AlarmName, 'rollback-factory-demo-service-lambda-errors-dev');
  assert.equal(alarm.Properties.Threshold, 1);
  const resources = alarm.Properties.Metrics.filter((m: any) => m.MetricStat)
    .map((m: any) => m.MetricStat.Metric.Dimensions.find((d: any) => d.Name === 'Resource').Value).sort();
  assert.deepEqual(resources, ['service-lambda-dev', 'service-lambda-dev:$LATEST', 'service-lambda-dev:live']);
  assert.ok(!JSON.stringify(alarm).includes(':integration'));
  t.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmActions: [{ Ref: Match.stringLikeRegexp('RollbackTopic') }] });
});

test('the topic is TLS only and lets CloudWatch publish for the registered alarms', () => {
  synth().hasResourceProperties('AWS::SNS::TopicPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        Match.objectLike({
          Sid: 'AllowCloudWatchAlarms',
          Principal: { Service: 'cloudwatch.amazonaws.com' },
          Condition: Match.objectLike({ StringEquals: { 'aws:SourceAccount': Match.anyValue() } }),
        }),
      ]),
    },
  });
});

test('the rollback role may only touch registered functions, their S3 folder and table items', () => {
  const t = synth();
  const policies = Object.values(t.findResources('AWS::IAM::Policy')) as any[];
  const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
  const text = JSON.stringify(statements);
  const lambdaStatement = statements.find((s) => [s.Action].flat().includes('lambda:UpdateAlias'));
  assert.match(JSON.stringify(lambdaStatement.Resource), /function:service-lambda-dev/);
  assert.match(text, /service-lambda-dev\/\*/);
  assert.match(text, /"dynamodb:LeadingKeys":\["service-lambda-dev"\]/);
});

test('keeps the versions table and artifacts bucket in prod only', () => {
  for (const [env, policy] of [['dev', 'Delete'], ['prod', 'Retain']]) {
    const t = synth(env);
    t.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: policy });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: policy });
  }
});

test('runs the scheduled check every 5 minutes', () => {
  synth().hasResourceProperties('AWS::Events::Rule', {
    Name: 'rollback-factory-demo-lambda-rollback-check-dev',
    ScheduleExpression: 'rate(5 minutes)',
    Targets: [Match.objectLike({ Input: JSON.stringify({ type: 'scheduled-check' }) })],
  });
});

test('prefixes export names, so they never clash with the API or frontend stacks', () => {
  for (const [name, output] of Object.entries(synth().findOutputs('*'))) {
    assert.match((output as any).Export.Name, /^rollback-factory-demo-lambda-/, name);
  }
});
