import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config.js';
import { RollbackServiceEdgeStack, RollbackServiceStack } from '../lib/rollback-service-stack.js';

const env = { account: '123456789012', region: 'eu-central-1' };
const synth = (envName = 'dev', overrides = {}) => {
  const app = new cdk.App();
  const config = getConfig(envName, overrides);
  // both stacks before the first synth: the app can't change after it
  const main = new RollbackServiceStack(app, 'Main', { config, env });
  const edge = new RollbackServiceEdgeStack(app, 'Edge', { config, env: { ...env, region: 'us-east-1' } });
  return { main: Template.fromStack(main), edge: Template.fromStack(edge) };
};

const statements = (t: Template) => Object.values(t.findResources('AWS::IAM::Policy'))
  .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
const actions = (s: any) => [s.Action].flat();

test('one rollback Lambda per environment', () => {
  const { main } = synth('staging');
  main.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'rollback-factory-demo-rollback-service-staging',
    Runtime: 'nodejs24.x',
    // a stack restore waits for CloudFormation's update
    Timeout: 600,
    Environment: { Variables: Match.objectLike({ ENV_NAME: 'staging', VERSIONS_TABLE_NAME: Match.anyValue(), STACK_TEMPLATES_TABLE_NAME: Match.anyValue() }) },
  });
});

test('a TLS-only topic per region that CloudWatch may publish rollback-factory-demo-* alarms to', () => {
  const { main, edge } = synth();
  for (const t of [main, edge]) {
    t.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'rollback-factory-demo-rollback-notifications-dev' });
    t.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
          Match.objectLike({ Sid: 'AllowCloudWatchAlarms', Principal: { Service: 'cloudwatch.amazonaws.com' } }),
        ]),
      },
    });
  }
  const policy: any = Object.values(edge.findResources('AWS::SNS::TopicPolicy'))[0];
  assert.match(JSON.stringify(policy), /alarm:rollback-factory-demo-\*/);
});

test('the Lambda subscribes to its own topic and, cross-region, to the us-east-1 one', () => {
  const { main } = synth();
  const subscriptions = Object.values(main.findResources('AWS::SNS::Subscription')).map((s: any) => s.Properties);
  assert.equal(subscriptions.length, 2);
  const edge = subscriptions.find((s) => s.Region === 'us-east-1');
  assert.ok(edge, 'cross-region subscription');
  assert.equal(edge.Protocol, 'lambda');
  assert.match(JSON.stringify(edge.TopicArn), /:sns:us-east-1:.*rollback-factory-demo-rollback-notifications-dev/);
  main.hasResourceProperties('AWS::Lambda::Permission', {
    Principal: 'sns.amazonaws.com',
    SourceArn: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
  });
});

test('e-mail subscriptions on both topics with -c alarmEmail', () => {
  const { main, edge } = synth('dev', { alarmEmail: 'ops@example.com' });
  for (const t of [main, edge]) t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
});

test('may read the project stacks\' RollbackTarget and act on their resources', () => {
  const { main } = synth();
  const all = statements(main);
  const describe = all.find((s) => actions(s).includes('cloudformation:DescribeStacks'));
  assert.match(JSON.stringify(describe.Resource), /stack\/deploy-aws-api-gateway-dev\/\*/);
  assert.match(JSON.stringify(describe.Resource), /stack\/deploy-aws-cloudfront-dev\/\*/);
  assert.ok(all.some((s) => actions(s).includes('apigateway:PUT')));
  const cloudfront = all.find((s) => actions(s).includes('cloudfront:UpdateDistribution'));
  assert.match(JSON.stringify(cloudfront.Resource), /:distribution\/\*/);
  const text = JSON.stringify(all);
  for (const table of ['rollback-factory-demo-deployments-dev', 'rollback-factory-demo-frontend-deployments-dev']) {
    assert.ok(text.includes(table), `may write ${table}`);
  }
});

test('the Lambda manager\'s role is scoped to the registered functions', () => {
  const { main } = synth();
  const lambdaStatement = statements(main).find((s) => actions(s).includes('lambda:UpdateAlias'));
  assert.match(JSON.stringify(lambdaStatement.Resource), /function:service-lambda-dev/);
  assert.match(JSON.stringify(statements(main)), /"dynamodb:LeadingKeys":\["service-lambda-dev","rollback-factory-demo-api-users-dev","rollback-factory-demo-api-messages-dev","rollback-factory-demo-api-orders-dev"]/);
});

test('owns the Lambda version archive, kept in prod only', () => {
  for (const [envName, policy] of [['dev', 'Delete'], ['prod', 'Retain']]) {
    const { main } = synth(envName);
    main.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: policy,
      Properties: Match.objectLike({ TableName: `rollback-factory-demo-lambda-archive-${envName}` }),
    });
    main.hasResource('AWS::S3::Bucket', { DeletionPolicy: policy });
  }
});

test('owns the CloudFormation template archive, kept in prod only', () => {
  for (const [envName, policy] of [['dev', 'Delete'], ['prod', 'Retain']]) {
    const { main } = synth(envName);
    main.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: policy,
      Properties: Match.objectLike({
        TableName: `rollback-factory-demo-stack-templates-${envName}`,
        KeySchema: [{ AttributeName: 'stackName', KeyType: 'HASH' }, { AttributeName: 'deployedAt', KeyType: 'RANGE' }],
      }),
    });
    main.hasOutput('StackTemplatesBucketName', Match.anyValue());
  }
});

test('may update only the stacks it restores, passing them only the CDK execution role', () => {
  const { main } = synth();
  const update = statements(main).find((s) => actions(s).includes('cloudformation:UpdateStack'));
  assert.match(JSON.stringify(update.Resource), /stack\/deploy-aws-api-gateway-dev\/\*/);
  assert.match(JSON.stringify(update.Resource), /stack\/deploy-aws-lambda-dev\/\*/);
  assert.doesNotMatch(JSON.stringify(update.Resource), /rollback-service|cloudfront/);
  const passRole = statements(main).find((s) => actions(s).includes('iam:PassRole'));
  assert.match(JSON.stringify(passRole.Resource), /role\/cdk-\*-cfn-exec-role-/);
  assert.deepEqual(passRole.Condition, { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } });
});

test('runs the scheduled check every 5 minutes', () => {
  synth().main.hasResourceProperties('AWS::Events::Rule', {
    Name: 'rollback-factory-demo-rollback-service-check-dev',
    ScheduleExpression: 'rate(5 minutes)',
    Targets: [Match.objectLike({ Input: JSON.stringify({ type: 'scheduled-check' }) })],
  });
});

test('prefixes export names, so they never clash with the project stacks', () => {
  const { main, edge } = synth();
  for (const t of [main, edge]) {
    for (const [name, output] of Object.entries(t.findOutputs('*'))) {
      assert.match((output as any).Export.Name, /^rollback-factory-demo-rollback-service-/, name);
    }
  }
});

test('logs to rollback-factory-demo-rollback-service-logs-<env>, where the dashboard follows its restores', () => {
  const { main } = synth('dev');
  main.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: 'rollback-factory-demo-rollback-service-logs-dev' });
  main.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'rollback-factory-demo-rollback-service-dev',
    LoggingConfig: { LogGroup: Match.anyValue() },
  });
});
