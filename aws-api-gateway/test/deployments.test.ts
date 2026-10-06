import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config.js';
import { ApiUserStack } from '../lib/api-user-stack.js';
import { buildRecord, compactTimestamp, DeploymentRecord, formatDuration, retirement, specKey } from '../lambda/shared/deployments.js';

const synth = (env: string) => {
  const app = new cdk.App();
  return Template.fromStack(new ApiUserStack(app, `Test-${env}`, { config: getConfig(env) }));
};

test('creates the spec bucket rollback-factory-demo-<account>-deployments-<env>', () => {
  const t = synth('dev');
  t.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: { 'Fn::Join': ['', ['rollback-factory-demo-', { Ref: 'AWS::AccountId' }, '-deployments-dev']] },
    VersioningConfiguration: { Status: 'Enabled' },
  });
});

test('creates the deployments table keyed by api and time', () => {
  const t = synth('prod');
  t.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
    TableName: 'rollback-factory-demo-deployments-prod',
    KeySchema: [
      { AttributeName: 'apiName', KeyType: 'HASH' },
      { AttributeName: 'deployedAt', KeyType: 'RANGE' },
    ],
  });
  // prod keeps its history when the stack is deleted
  t.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
  t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
});

test('names spec objects <apiName>/<timestamp>/openapi.json', () => {
  const date = new Date('2026-10-06T12:30:05.123Z');
  assert.equal(compactTimestamp(date), '20261006T123005Z');
  assert.equal(specKey('api-user-dev', date), 'api-user-dev/20261006T123005Z/openapi.json');
});

test('builds a deployment record', () => {
  const now = new Date('2026-10-06T12:30:05.123Z');
  const record = buildRecord(
    { apiName: 'api-user-dev', restApiId: 'abc123', stageName: 'v1', specBucket: 'bucket', table: 'table' },
    'dep42',
    { source: 'cicd', actor: 'github:someone', commitSha: 'deadbeef', now },
  );
  assert.deepEqual(record, {
    apiName: 'api-user-dev',
    deployedAt: '2026-10-06T12:30:05.123Z',
    restApiId: 'abc123',
    stageName: 'v1',
    deploymentId: 'dep42',
    lambdaVersion: undefined,
    specBucket: 'bucket',
    specKey: 'api-user-dev/20261006T123005Z/openapi.json',
    source: 'cicd',
    actor: 'github:someone',
    commitSha: 'deadbeef',
    runUrl: undefined,
    description: undefined,
    rolledBackFrom: undefined,
    verifiedAt: undefined,
    current: true,
  });
});

const record = (deployedAt: string, extra: Partial<DeploymentRecord> = {}) => ({
  apiName: 'api-user-dev', deployedAt, deploymentId: deployedAt, source: 'cicd', current: true, ...extra,
} as DeploymentRecord);

test('a replaced deployment is stable for the time until the next deployment', () => {
  const previous = record('2026-10-06T10:00:00.000Z');
  const next = record('2026-10-06T12:30:05.600Z');
  assert.deepEqual(retirement(previous, next), {
    current: false, stable: true, stableFor: 9006, stableForHumanReadable: '2 hours 30 minutes',
  });
});

test('formats durations in days, hours and minutes', () => {
  assert.equal(formatDuration(0), '0 seconds');
  assert.equal(formatDuration(45), '45 seconds');
  assert.equal(formatDuration(60), '1 minute');
  assert.equal(formatDuration(9006), '2 hours 30 minutes');
  assert.equal(formatDuration(3 * 86_400 + 120), '3 days 2 minutes');
  assert.equal(formatDuration(90_061), '1 day 1 hour 1 minute');
});

test('a rolled-back deployment is unstable and gets no stableFor(HumanReadable)', () => {
  const previous = record('2026-10-06T10:00:00.000Z', { rolledBackAt: '2026-10-06T10:05:00.000Z' });
  const next = record('2026-10-06T10:05:01.000Z', { source: 'rollback' });
  assert.deepEqual(retirement(previous, next), { current: false, stable: false });
});
