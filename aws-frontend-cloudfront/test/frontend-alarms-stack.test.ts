import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ConfigOverrides, getConfig } from '../lib/config.js';
import { FrontendAlarmsStack } from '../lib/frontend-alarms-stack.js';
import { createFrontendStacks } from '../lib/frontend-app.js';

const synth = (overrides: ConfigOverrides = {}) => {
  const app = new cdk.App();
  const stack = new FrontendAlarmsStack(app, 'Test', {
    config: getConfig('dev', overrides),
    distributionId: 'E2EXAMPLE',
    mainRegion: 'eu-central-1',
    env: { region: 'us-east-1' },
  });
  return Template.fromStack(stack);
};

const alarm = (t: Template, name: string) => {
  const found = Object.values(t.findResources('AWS::CloudWatch::Alarm', { Properties: { AlarmName: name } })) as any[];
  assert.equal(found.length, 1, `alarm ${name}`);
  return found[0].Properties;
};

test('alarms on the CloudFront 4xx and 5xx error rates of the distribution', () => {
  const t = synth();
  t.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  for (const [name, metricName, threshold, minRequests] of [
    ['rollback-factory-demo-frontend-4xx-rate-dev', '4xxErrorRate', 25, 20],
    ['rollback-factory-demo-frontend-5xx-rate-dev', '5xxErrorRate', 5, 5],
  ] as const) {
    const props = alarm(t, name);
    assert.equal(props.Threshold, threshold);
    assert.equal(props.ComparisonOperator, 'GreaterThanThreshold');
    assert.equal(props.EvaluationPeriods, 3);
    assert.equal(props.DatapointsToAlarm, 2);
    assert.equal(props.TreatMissingData, 'notBreaching');

    const expression = props.Metrics.find((m: any) => m.Expression);
    assert.equal(expression.Expression, `IF(requests >= ${minRequests}, rate, 0)`);
    assert.equal(expression.ReturnData, true);
    const metrics = Object.fromEntries(props.Metrics.filter((m: any) => m.MetricStat).map((m: any) => [m.Id, m.MetricStat]));
    assert.deepEqual(metrics.rate.Metric, {
      Namespace: 'AWS/CloudFront',
      MetricName: metricName,
      Dimensions: [{ Name: 'DistributionId', Value: 'E2EXAMPLE' }, { Name: 'Region', Value: 'Global' }],
    });
    assert.equal(metrics.rate.Stat, 'Average');
    assert.equal(metrics.requests.Metric.MetricName, 'Requests');
    assert.equal(metrics.requests.Stat, 'Sum');
    assert.equal(metrics.rate.Period, 60);
  }
});

test('notifies the SNS topic, which only CloudWatch (for these alarms) and TLS may use', () => {
  const t = synth();
  t.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'rollback-factory-demo-frontend-notifications-dev' });
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    ActionsEnabled: true,
    AlarmActions: [{ Ref: Match.stringLikeRegexp('AlarmTopic') }],
  });
  t.hasResourceProperties('AWS::SNS::TopicPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        Match.objectLike({
          Sid: 'AllowCloudWatchAlarms',
          Effect: 'Allow',
          Principal: { Service: 'cloudwatch.amazonaws.com' },
          Action: 'sns:Publish',
          Condition: {
            StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
            ArnLike: { 'aws:SourceArn': [{ 'Fn::GetAtt': [Match.stringLikeRegexp('Alarm4xx'), 'Arn'] }, { 'Fn::GetAtt': [Match.stringLikeRegexp('Alarm5xx'), 'Arn'] }] },
          },
        }),
      ]),
    },
  });
});

test('alarmNotifications=false keeps the alarms but turns their actions off', () => {
  const t = synth({ alarmNotifications: 'false' });
  t.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  t.allResourcesProperties('AWS::CloudWatch::Alarm', { ActionsEnabled: false });
});

test('alarmEmail subscribes an e-mail address to the topic', () => {
  const emails = (t: Template) => Object.keys(t.findResources('AWS::SNS::Subscription', { Properties: { Protocol: 'email' } }));
  assert.deepEqual(emails(synth()), []);
  synth({ alarmEmail: 'ops@example.com' }).hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'email', Endpoint: 'ops@example.com',
  });
});

test('exports the alarm names and topic', () => {
  const outputs = synth().findOutputs('*');
  for (const name of ['AlarmTopicArn', 'Alarm4xxName', 'Alarm5xxName', 'RollbackFunctionName']) {
    assert.deepEqual(outputs[name]?.Export, { Name: `rollback-factory-demo-frontend-${name}-dev` });
  }
});

test('reads the distribution id from the main stack across regions', () => {
  const app = new cdk.App();
  const { alarms } = createFrontendStacks(app, getConfig('dev'), { account: '123456789012', region: 'eu-central-1' });
  const props = alarm(Template.fromStack(alarms), 'rollback-factory-demo-frontend-4xx-rate-dev');
  const rate = props.Metrics.find((m: any) => m.Id === 'rate');
  const [distribution] = rate.MetricStat.Metric.Dimensions;
  // a cross-region reference resolves through an SSM parameter written by the main stack
  assert.match(JSON.stringify(distribution.Value), /ExportsReader/);
});
