import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { getConfig, isPrEnv } from '../lib/config.js';
import { LambdaServiceStack } from '../lib/lambda-service-stack.js';

const synth = (env: string) => Template.fromStack(
  new LambdaServiceStack(new cdk.App(), `Test-${env}`, { config: getConfig(env), versionDescription: 'test' }),
);

test('accepts a pull request\'s environment pr-<number>, and nothing like it', () => {
  assert.ok(isPrEnv('pr-123'));
  for (const env of ['pr-', 'pr-0', 'pr-12a', 'pr-1 ', 'PR-1', 'pr--1']) {
    assert.ok(!isPrEnv(env), env);
    assert.throws(() => getConfig(env), /Unknown env/, env);
  }
  assert.equal(getConfig('dev').pr, false);
});

test('names a pull request\'s resources after its number', () => {
  const config = getConfig('pr-123');
  assert.equal(config.pr, true);
  assert.equal(config.functionName, 'service-lambda-pr-123');
  assert.equal(config.stackName, 'deploy-aws-lambda-pr-123');
  assert.equal(config.errorsAlarmName, 'rollback-factory-demo-lambda-service-lambda-errors-pr-123');
  assert.equal(config.retainData, false);
});

test('a pull request\'s errors alarm notifies nobody; the others notify the rollback service', () => {
  const actions = (env: string) => Object.values(synth(env).findResources('AWS::CloudWatch::Alarm'))
    .map((alarm: any) => alarm.Properties.AlarmActions);
  assert.deepEqual(actions('pr-123'), [undefined]);
  assert.equal(actions('dev')[0].length, 1);
});
