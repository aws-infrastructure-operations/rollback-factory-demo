import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config.js';
import { ApiUserStack } from '../lib/api-user-stack.js';
import { buildRecord, compactTimestamp, specKey } from '../lambda/shared/deployments.js';

const synth = (env: string) => {
  const app = new cdk.App();
  return Template.fromStack(new ApiUserStack(app, `Test-${env}`, { config: getConfig(env) }));
};

test('creates the spec bucket <api>-<account>-deployments', () => {
  const t = synth('dev');
  t.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: { 'Fn::Join': ['', ['api-user-dev-', { Ref: 'AWS::AccountId' }, '-deployments']] },
    VersioningConfiguration: { Status: 'Enabled' },
  });
});

test('creates the deployments table keyed by api and time', () => {
  const t = synth('prod');
  t.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
    TableName: 'api-user-prod-deployments',
    KeySchema: [
      { AttributeName: 'apiName', KeyType: 'HASH' },
      { AttributeName: 'deployedAt', KeyType: 'RANGE' },
    ],
  });
  // prod keeps its history when the stack is deleted
  t.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
  t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
});

test('names spec objects by deployment timestamp', () => {
  const date = new Date('2026-10-06T12:30:05.123Z');
  assert.equal(compactTimestamp(date), '20261006T123005Z');
  assert.equal(specKey(date), 'specs/20261006T123005Z/openapi.json');
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
    specBucket: 'bucket',
    specKey: 'specs/20261006T123005Z/openapi.json',
    source: 'cicd',
    actor: 'github:someone',
    commitSha: 'deadbeef',
    runUrl: undefined,
    description: undefined,
    rolledBackFrom: undefined,
  });
});
