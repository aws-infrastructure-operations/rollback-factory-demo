import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { alarmName, getConfig, parseAlarmName } from '../lib/config.js';
import { createRouter, type AlarmNotification, type Managers } from '../lambda/router.js';
import { createTargetReader } from '../lambda/targets.js';

test('names the service per environment', () => {
  for (const env of ['dev', 'testing', 'staging', 'prod']) {
    const config = getConfig(env);
    assert.equal(config.stackName, `rollback-service-${env}`);
    assert.equal(config.edgeStackName, `rollback-service-us-east-1-${env}`);
    assert.equal(config.functionName, `rollback-factory-demo-rollback-service-${env}`);
    assert.equal(config.topicName, `rollback-factory-demo-rollback-notifications-${env}`);
    assert.equal(config.retainData, env === 'prod');
  }
  assert.throws(() => getConfig('qa'), /Unknown env "qa"/);
});

test('reads the manager type and environment from the alarm name', () => {
  assert.deepEqual(parseAlarmName('rollback-factory-demo-apigateway-api-user-5xx-rate-dev'),
    { type: 'apigateway', name: 'api-user-5xx-rate', env: 'dev' });
  assert.deepEqual(parseAlarmName('rollback-factory-demo-cloudfront-frontend-user-4xx-rate-staging'),
    { type: 'cloudfront', name: 'frontend-user-4xx-rate', env: 'staging' });
  assert.deepEqual(parseAlarmName('rollback-factory-demo-lambda-service-lambda-errors-prod'),
    { type: 'lambda', name: 'service-lambda-errors', env: 'prod' });
  assert.equal(alarmName('lambda', 'service-lambda-errors', 'prod'), 'rollback-factory-demo-lambda-service-lambda-errors-prod');
  for (const other of [
    'rollback-factory-demo-api-user-5xx-rate-dev', // no type segment (the old names)
    'rollback-factory-demo-ec2-cpu-dev', // unknown type
    'rollback-factory-demo-apigateway-api-user-5xx-rate-qa', // unknown env
    'other-project-apigateway-x-dev',
  ]) assert.equal(parseAlarmName(other), undefined, other);
});

/** Managers that record what they were asked to do. */
const recordingManagers = () => {
  const calls: Array<[string, unknown]> = [];
  const managers: Managers = {
    apigateway: async (alarm: AlarmNotification) => { calls.push(['apigateway', alarm.alarmName]); return 'api'; },
    apigatewayRestore: async (req) => { calls.push(['apigatewayRestore', req.deployedAt]); return 'restored'; },
    cloudfront: async (alarm: AlarmNotification) => { calls.push(['cloudfront', alarm.alarmName]); return 'cf'; },
    lambda: async (event) => { calls.push(['lambda', event]); return ['fn']; },
  };
  return { calls, managers };
};

const sns = (...names: string[]) => ({
  Records: names.map((name) => ({ Sns: { Message: JSON.stringify({ AlarmName: name, NewStateValue: 'ALARM', NewStateReason: 'test' }) } })),
});

test('routes each alarm to the manager its name says', async () => {
  const { calls, managers } = recordingManagers();
  const results = await createRouter('dev', managers)(sns(
    'rollback-factory-demo-apigateway-api-user-5xx-rate-dev',
    'rollback-factory-demo-cloudfront-frontend-user-4xx-rate-dev',
    'rollback-factory-demo-lambda-service-lambda-errors-dev',
  ));
  assert.deepEqual(calls.map(([manager]) => manager), ['apigateway', 'cloudfront', 'lambda']);
  assert.deepEqual((results as any[]).map((r) => [r.manager, r.result]), [['apigateway', 'api'], ['cloudfront', 'cf'], ['lambda', 'fn']]);
  // the Lambda manager gets the SNS record itself, as it did when it had its own function
  const [, lambdaEvent] = calls[2] as [string, any];
  assert.equal(JSON.parse(lambdaEvent.Records[0].Sns.Message).AlarmName, 'rollback-factory-demo-lambda-service-lambda-errors-dev');
});

test("skips alarms of another environment and names outside the convention", async () => {
  const { calls, managers } = recordingManagers();
  const results = await createRouter('dev', managers)(sns(
    'rollback-factory-demo-apigateway-api-user-5xx-rate-prod',
    'rollback-factory-demo-api-user-5xx-rate-dev',
  )) as any[];
  assert.deepEqual(calls, []);
  assert.match(results[0].reason, /belongs to prod; this is the dev rollback service/);
  assert.match(results[1].reason, /is not a rollback-factory-demo-<type>-<name>-<env> alarm/);
});

test('skips OK and INSUFFICIENT_DATA notifications without asking a manager', async () => {
  const { calls, managers } = recordingManagers();
  const ok = { Records: [{ Sns: { Message: JSON.stringify({
    AlarmName: 'rollback-factory-demo-apigateway-api-user-5xx-rate-dev', NewStateValue: 'OK', NewStateReason: 'recovered',
  }) } }] };
  const [result] = await createRouter('dev', managers)(ok) as any[];
  assert.deepEqual(calls, []);
  assert.equal(result.reason, 'state is OK, not ALARM');
});

test('sends scheduled checks and syncs to the Lambda manager, restores to the API Gateway manager', async () => {
  const { calls, managers } = recordingManagers();
  const route = createRouter('dev', managers);
  await route({ type: 'scheduled-check' });
  await route({ type: 'sync', functionName: 'service-lambda-dev' });
  assert.equal(await route({ type: 'restore', manager: 'apigateway', deployedAt: '2026-10-06T11:00:00.000Z' }), 'restored');
  assert.deepEqual(calls, [
    ['lambda', { type: 'scheduled-check' }],
    ['lambda', { type: 'sync', functionName: 'service-lambda-dev' }],
    ['apigatewayRestore', '2026-10-06T11:00:00.000Z'],
  ]);
  await assert.rejects(route({ type: 'nope' } as any), /Unknown event/);
});

test('reads a stack RollbackTarget once per invocation', async () => {
  let reads = 0;
  const reader = createTargetReader({
    send: async () => {
      reads++;
      return { Stacks: [{ Outputs: [{ OutputKey: 'RollbackTarget', OutputValue: JSON.stringify({ apiName: 'api-user-dev' }) }] }] };
    },
  } as any);
  assert.deepEqual(await reader.get('deploy-aws-api-gateway-dev'), { apiName: 'api-user-dev' });
  await reader.get('deploy-aws-api-gateway-dev');
  assert.equal(reads, 1);
  reader.clear();
  await reader.get('deploy-aws-api-gateway-dev');
  assert.equal(reads, 2);

  const empty = createTargetReader({ send: async () => ({ Stacks: [{ Outputs: [] }] }) } as any);
  await assert.rejects(empty.get('deploy-aws-cloudfront-dev'), /has no RollbackTarget output/);
});
