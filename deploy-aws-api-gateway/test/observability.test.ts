import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config.js';
import { ApiUserStack } from '../lib/api-user-stack.js';

const app = new cdk.App();
const t = Template.fromStack(new ApiUserStack(app, 'Test-dev', { config: getConfig('dev') }));

test('writes JSON access logs that separate API Gateway and Lambda failures', () => {
  t.hasResourceProperties('AWS::Logs::LogGroup', {
    LogGroupName: 'rollback-factory-demo-api-access-logs-dev',
    RetentionInDays: 30,
  });

  const [stage] = Object.values(t.findResources('AWS::ApiGateway::Stage')) as any[];
  const settings = stage.Properties.AccessLogSetting;
  assert.ok(settings.DestinationArn, 'access logs need a destination');
  const format = JSON.parse(settings.Format);
  assert.equal(format.errorType, '$context.error.responseType');
  assert.equal(format.integrationStatus, '$context.integration.status');
  assert.equal(format.lambdaServiceStatus, '$context.integrationStatus');
  assert.equal(format.integrationError, '$context.integration.error');
  assert.equal(format.integrationErrorMessage, '$context.integrationErrorMessage');
  assert.equal(format.lambdaRequestId, '$context.integration.requestId');
  assert.equal(format.status, '$context.status');
});

test('sets up the account-level CloudWatch role API Gateway needs for logging', () => {
  t.resourceCountIs('AWS::ApiGateway::Account', 1);
  t.hasResource('AWS::IAM::Role', {
    Properties: {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Principal: { Service: 'apigateway.amazonaws.com' } })],
      }),
    },
    DeletionPolicy: 'Retain',
  });
});

test('saves Logs Insights queries for 5xx by cause and the latest 5xx requests', () => {
  t.hasResourceProperties('AWS::Logs::QueryDefinition', {
    Name: 'rollback-factory-demo-api-5xx-by-cause-dev',
    QueryString: Match.stringLikeRegexp('stats count\\(\\*\\) as requests by errorType, integrationStatus'),
  });
  t.hasResourceProperties('AWS::Logs::QueryDefinition', {
    Name: 'rollback-factory-demo-api-5xx-requests-dev',
    QueryString: Match.stringLikeRegexp('lambdaRequestId'),
  });
});

test('alarms on Lambda errors without triggering a rollback', () => {
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'rollback-factory-demo-apigateway-api-user-handler-errors-dev',
    Namespace: 'AWS/Lambda',
    MetricName: 'Errors',
    Threshold: 0,
    ComparisonOperator: 'GreaterThanThreshold',
  });
  // the rollback service's API Gateway manager only rolls back on these two (RollbackTarget.alarmNames)
  const target = JSON.stringify(t.findOutputs('RollbackTarget').RollbackTarget.Value);
  assert.ok(target.includes('rollback-factory-demo-apigateway-api-user-4xx-rate-dev'));
  assert.ok(!target.includes('"alarmNames":["rollback-factory-demo-apigateway-api-user-handler-errors-dev'));
});
