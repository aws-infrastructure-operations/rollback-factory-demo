import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { getConfig } from '../lib/config.js';

test('names the function service-lambda-<env> and points at the rollback service', () => {
  for (const env of ['dev', 'testing', 'staging', 'prod']) {
    const config = getConfig(env);
    assert.equal(config.functionName, `service-lambda-${env}`);
    assert.equal(config.stackName, `deploy-aws-lambda-${env}`);
    assert.equal(config.rollbackServiceFunctionName, `rollback-factory-demo-rollback-service-${env}`);
    assert.equal(config.versionsTableName, `rollback-factory-demo-lambda-archive-${env}`);
    assert.equal(config.rollbackTopicName, `rollback-factory-demo-rollback-notifications-${env}`);
    assert.equal(config.errorsAlarmName, `rollback-factory-demo-lambda-service-lambda-errors-${env}`);
  }
});

test('rejects unknown environments and invalid live versions', () => {
  assert.throws(() => getConfig('qa'), /Unknown env "qa"/);
  assert.throws(() => getConfig(undefined), /Unknown env/);
  assert.throws(() => getConfig('dev', { liveLambdaVersion: '$LATEST' }), /liveLambdaVersion/);
  assert.equal(getConfig('dev', { liveLambdaVersion: '7' }).liveLambdaVersion, '7');
  assert.equal(getConfig('dev', { liveLambdaVersion: '' }).liveLambdaVersion, undefined);
});
