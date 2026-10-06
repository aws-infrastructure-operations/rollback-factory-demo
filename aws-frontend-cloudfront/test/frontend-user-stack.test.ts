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

test('retains the site bucket in prod only', () => {
  synth('prod').hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  synth('dev').hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
});

test('exports the outputs later scripts read', () => {
  const outputs = synth('dev').findOutputs('*');
  for (const name of ['DistributionId', 'DistributionDomainName', 'SiteUrl', 'SiteBucketName', 'LiveReleaseId']) {
    assert.ok(outputs[name], `missing output ${name}`);
    assert.deepEqual(outputs[name].Export, { Name: `rollback-factory-demo-${name}-dev` });
  }
});
