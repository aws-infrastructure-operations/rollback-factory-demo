import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveRegistry } from '../lambda/managers/lambda/registry.js';
import rollbackConfig from '../rollback-config.json';

test('the registry resolves <env> and registers the service with its errors alarm', () => {
  const registry = resolveRegistry(rollbackConfig, 'staging');
  assert.deepEqual([...registry.keys()], ['service-lambda-staging']);
  const service = registry.get('service-lambda-staging')!;
  assert.equal(service.alias, 'live');
  // the alarm deploy-aws-lambda creates: rollback-factory-demo-lambda-<name>-<env>, so the router picks the Lambda manager
  assert.deepEqual([...service.alarms], ['rollback-factory-demo-lambda-service-lambda-errors-staging']);
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
