import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config.js';
import { FrontendUserStack } from '../lib/frontend-user-stack.js';

const synth = (env: string, liveReleaseId?: string) => {
  const app = new cdk.App();
  const stack = new FrontendUserStack(app, `Test-${env}`, { config: getConfig(env, { liveReleaseId }) });
  return Template.fromStack(stack);
};

const distributionConfig = (t: Template) => {
  const [distribution] = Object.values(t.findResources('AWS::CloudFront::Distribution')) as any[];
  return distribution.Properties.DistributionConfig;
};

test('names the distribution frontend-user-<env>', () => {
  for (const env of ['dev', 'prod']) {
    const t = synth(env);
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
    assert.equal(distributionConfig(t).Comment, `frontend-user-${env}`);
  }
});

test('keeps the site bucket private and HTTPS only', () => {
  const t = synth('dev');
  t.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    },
  });
  t.hasResourceProperties('AWS::S3::Bucket', Match.not({ WebsiteConfiguration: Match.anyValue() }));
  // enforceSSL denies plain HTTP
  t.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
      ]),
    },
  });
  const config = distributionConfig(t);
  assert.equal(config.DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https');
  assert.equal(config.DefaultRootObject, 'index.html');
});

test('reads the bucket through Origin Access Control, for this distribution only', () => {
  const t = synth('dev');
  t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
    OriginAccessControlConfig: { OriginAccessControlOriginType: 's3', SigningBehavior: 'always' },
  });
  const [origin] = distributionConfig(t).Origins;
  assert.ok(origin.OriginAccessControlId, 'origin uses OAC');
  assert.deepEqual(origin.S3OriginConfig, { OriginAccessIdentity: '' }, 'no legacy OAI');
  t.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Allow',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Action: 's3:GetObject',
          Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
        }),
      ]),
    },
  });
});

test('points the origin path at the live release, or the placeholder', () => {
  assert.equal(distributionConfig(synth('dev')).Origins[0].OriginPath, '/releases/initial');
  assert.equal(distributionConfig(synth('dev', '20261006T123005Z')).Origins[0].OriginPath, '/releases/20261006T123005Z');
});

test('has no SPA fallback, so a missing file stays a 4xx', () => {
  assert.equal(distributionConfig(synth('dev')).CustomErrorResponses, undefined);
});

test('deploys the placeholder into releases/initial/ without pruning other releases', () => {
  synth('dev').hasResourceProperties('Custom::CDKBucketDeployment', {
    DestinationBucketKeyPrefix: 'releases/initial/',
    Prune: false,
  });
});

test('retains the buckets in prod only', () => {
  const deletionPolicies = (env: string) =>
    Object.values(synth(env).findResources('AWS::S3::Bucket')).map((b: any) => b.DeletionPolicy);
  assert.deepEqual(deletionPolicies('prod'), ['Retain', 'Retain']);
  assert.deepEqual(deletionPolicies('dev'), ['Delete', 'Delete']);
});

test('keeps build manifests in a versioned, private deployments bucket', () => {
  const t = synth('dev');
  t.resourceCountIs('AWS::S3::Bucket', 2);
  t.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: { 'Fn::Join': ['', ['rollback-factory-demo-', { Ref: 'AWS::AccountId' }, '-frontend-deployments-dev']] },
    VersioningConfiguration: { Status: 'Enabled' },
    PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicPolicy: true, RestrictPublicBuckets: true }),
  });
});

test('records deployments in a DynamoDB table keyed by frontendName + deployedAt', () => {
  for (const env of ['dev', 'prod']) {
    const t = synth(env);
    t.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: env === 'prod' ? 'Retain' : 'Delete',
      Properties: Match.objectLike({
        TableName: `rollback-factory-demo-frontend-deployments-${env}`,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'frontendName', KeyType: 'HASH' },
          { AttributeName: 'deployedAt', KeyType: 'RANGE' },
        ],
        Replicas: [Match.objectLike({
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: env === 'prod' },
        })],
      }),
    });
  }
});

test('exports the outputs later scripts read', () => {
  const outputs = synth('dev').findOutputs('*');
  for (const name of ['DistributionId', 'DistributionDomainName', 'SiteUrl', 'SiteBucketName', 'DeploymentsBucketName', 'DeploymentsTableName']) {
    assert.ok(outputs[name], `missing output ${name}`);
    assert.deepEqual(outputs[name].Export, { Name: `rollback-factory-demo-frontend-${name}-dev` });
  }
});

test('never exports a name the api-user stack in the same region could use', () => {
  // the API exports rollback-factory-demo-<Output>-<env>; export names are unique per region
  for (const [name, output] of Object.entries(synth('dev').findOutputs('*'))) {
    const exportName = (output as any).Export?.Name;
    if (exportName) assert.match(exportName, /^rollback-factory-demo-frontend-/, name);
  }
});
