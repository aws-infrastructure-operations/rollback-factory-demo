import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { getConfig } from '../lib/config.js';
import { createFrontendStacks } from '../lib/frontend-app.js';

test('names the frontend and its resources per environment', () => {
  for (const env of ['dev', 'testing', 'staging', 'prod']) {
    const config = getConfig(env);
    assert.equal(config.frontendName, `frontend-user-${env}`);
    assert.equal(config.integrationName, `frontend-user-${env}-integration`);
    assert.equal(config.resourceName('site'), `rollback-factory-demo-site-${env}`);
    assert.equal(config.stackName, `rollback-factory-demo-frontend-${env}`);
    assert.equal(config.alarmsStackName, `rollback-factory-demo-frontend-alarms-${env}`);
  }
  for (const env of ['dev', 'testing', 'staging']) assert.equal(getConfig(env).retainData, false);
  assert.equal(getConfig('prod').retainData, true);
});

test('rejects unknown environments', () => {
  assert.throws(() => getConfig('qa'), /Unknown env "qa"/);
  assert.throws(() => getConfig(undefined), /Unknown env/);
});

test('parses overrides from CDK context strings', () => {
  const config = getConfig('dev', {
    alarmNotifications: 'false',
    alarmEmail: 'ops@example.com',
    rollbackWindowMinutes: '15',
    liveReleaseId: '20261006T123005Z',
    integrationReleaseId: '20261006T124500Z',
  });
  assert.equal(config.alarms.notificationsEnabled, false);
  assert.equal(config.alarms.email, 'ops@example.com');
  assert.equal(config.rollbackWindowMinutes, 15);
  assert.equal(config.liveReleaseId, '20261006T123005Z');
  assert.equal(config.integrationReleaseId, '20261006T124500Z');

  const defaults = getConfig('dev', { liveReleaseId: '' });
  assert.equal(defaults.alarms.notificationsEnabled, true);
  assert.equal(defaults.alarms.email, undefined);
  assert.equal(defaults.rollbackWindowMinutes, 30);
  assert.equal(defaults.liveReleaseId, undefined);
});

test('rejects invalid overrides', () => {
  assert.throws(() => getConfig('dev', { liveReleaseId: '../other' }), /liveReleaseId/);
  assert.throws(() => getConfig('dev', { integrationReleaseId: 'latest' }), /integrationReleaseId/);
  assert.throws(() => getConfig('dev', { rollbackWindowMinutes: 'soon' }), /rollbackWindowMinutes/);
  assert.throws(() => getConfig('dev', { rollbackWindowMinutes: 0 }), /rollbackWindowMinutes/);
});

test('puts the alarms stack in us-east-1, after the main stack', () => {
  const app = new cdk.App();
  const { main, alarms } = createFrontendStacks(app, getConfig('dev'), { account: '123456789012', region: 'eu-central-1' });
  assert.equal(main.stackName, 'rollback-factory-demo-frontend-dev');
  assert.equal(main.region, 'eu-central-1');
  assert.equal(alarms.stackName, 'rollback-factory-demo-frontend-alarms-dev');
  assert.equal(alarms.region, 'us-east-1');
  assert.equal(alarms.account, '123456789012');
  assert.deepEqual(alarms.dependencies, [main]);
});
