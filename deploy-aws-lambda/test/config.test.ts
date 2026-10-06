import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { getConfig } from '../lib/config.js';
import { resolveRegistry } from '../lambda/rollback/registry.js';
import rollbackConfig from '../rollback-config.json';

test('names the function service-lambda-<env> and the rest rollback-factory-demo-<resource>-<env>', () => {
  for (const env of ['dev', 'testing', 'staging', 'prod']) {
    const config = getConfig(env);
    assert.equal(config.functionName, `service-lambda-${env}`);
    assert.equal(config.stackName, `deploy-aws-lambda-${env}`);
    assert.equal(config.rollbackFunctionName, `rollback-factory-demo-lambda-rollback-${env}`);
    assert.equal(config.versionsTableName, `rollback-factory-demo-lambda-versions-${env}`);
    assert.equal(config.rollbackTopicName, `rollback-factory-demo-lambda-notifications-${env}`);
    assert.equal(config.errorsAlarmName, `rollback-factory-demo-service-lambda-errors-${env}`);
    assert.equal(config.retainData, env === 'prod');
  }
});

test('rejects unknown environments and invalid live versions', () => {
  assert.throws(() => getConfig('qa'), /Unknown env "qa"/);
  assert.throws(() => getConfig(undefined), /Unknown env/);
  assert.throws(() => getConfig('dev', { liveLambdaVersion: '$LATEST' }), /liveLambdaVersion/);
  assert.equal(getConfig('dev', { liveLambdaVersion: '7' }).liveLambdaVersion, '7');
  assert.equal(getConfig('dev', { liveLambdaVersion: '' }).liveLambdaVersion, undefined);
});

test('the registry resolves <env> and registers the service with its errors alarm', () => {
  const registry = resolveRegistry(rollbackConfig, 'staging');
  const config = getConfig('staging');
  assert.deepEqual([...registry.keys()], [config.functionName]);
  const service = registry.get(config.functionName)!;
  assert.equal(service.alias, 'live');
  assert.deepEqual([...service.alarms], [config.errorsAlarmName]);
  assert.equal(service.maxConsecutiveRollbacks, 2);
  assert.equal(service.deploymentWindowMinutes, 10);
});

test('the registry applies defaults and per-function overrides and drops disabled functions', () => {
  const registry = resolveRegistry({
    maxConsecutiveRollbacks: 4,
    functions: [
      { name: 'a-<env>', alarms: ['a-errors-<env>'] },
      { name: 'b-<env>', alias: 'prod', maxConsecutiveRollbacks: 0, deploymentWindowMinutes: 30 },
      { name: 'c-<env>', enabled: false },
    ],
  }, 'dev');
  assert.deepEqual([...registry.keys()], ['a-dev', 'b-dev']);
  assert.deepEqual({ ...registry.get('a-dev'), alarms: [...registry.get('a-dev')!.alarms] }, {
    name: 'a-dev', alias: 'live', alarms: ['a-errors-dev'], maxConsecutiveRollbacks: 4, deploymentWindowMinutes: 10,
  });
  assert.equal(registry.get('b-dev')!.alias, 'prod');
  assert.equal(registry.get('b-dev')!.maxConsecutiveRollbacks, 0);
  assert.equal(registry.get('b-dev')!.deploymentWindowMinutes, 30);
});
