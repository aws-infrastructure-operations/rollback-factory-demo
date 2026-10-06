import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ConfigOverrides, getConfig } from '../lib/config.js';
import { FrontendUserStack } from '../lib/frontend-user-stack.js';

const synth = (env: string, overrides: ConfigOverrides = {}) => {
  const app = new cdk.App();
  const stack = new FrontendUserStack(app, `Test-${env}`, { config: getConfig(env, overrides) });
  return Template.fromStack(stack);
};

/** DistributionConfig of the distribution with this construct id ('Distribution' or 'IntegrationDistribution'). */
const distributionConfig = (t: Template, id = 'Distribution') => {
  const [distribution] = Object.entries(t.findResources('AWS::CloudFront::Distribution'))
    .filter(([logicalId]) => logicalId.startsWith(id) && !logicalId.startsWith(`${id}Integration`))
    .map(([, resource]) => resource as any);
  return distribution.Properties.DistributionConfig;
};

test('names the distributions frontend-user-<env> and frontend-user-<env>-integration', () => {
  for (const env of ['dev', 'prod']) {
    const t = synth(env);
    t.resourceCountIs('AWS::CloudFront::Distribution', 2);
    assert.equal(distributionConfig(t).Comment, `frontend-user-${env}`);
    assert.equal(distributionConfig(t, 'IntegrationDistribution').Comment, `frontend-user-${env}-integration`);
  }
});

test('keeps the construct id of the existing distribution, so it is updated in place', () => {
  const ids = Object.keys(synth('dev').findResources('AWS::CloudFront::Distribution'));
  assert.ok(ids.some((id) => /^Distribution[0-9A-F]{8}$/.test(id)), ids.join(', '));
});

test('serves both distributions the same way', () => {
  const t = synth('dev');
  // everything but the comment and the generated origin id
  const comparable = (config: any) => ({ ...config, Comment: undefined, Origins: undefined, DefaultCacheBehavior: { ...config.DefaultCacheBehavior, TargetOriginId: undefined } });
  const { Origins: liveOrigins, ...live } = distributionConfig(t);
  const { Origins: integrationOrigins, ...integration } = distributionConfig(t, 'IntegrationDistribution');
  assert.deepEqual(comparable(integration), comparable(live));
  assert.deepEqual(integrationOrigins[0].DomainName, liveOrigins[0].DomainName, 'same site bucket');
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

test('reads the bucket through Origin Access Control, for these two distributions only', () => {
  const t = synth('dev');
  // one per distribution, so the existing distribution's resources stay untouched
  t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
  t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
    OriginAccessControlConfig: { OriginAccessControlOriginType: 's3', SigningBehavior: 'always' },
  });
  for (const id of ['Distribution', 'IntegrationDistribution']) {
    const [origin] = distributionConfig(t, id).Origins;
    assert.ok(origin.OriginAccessControlId, `${id} uses OAC`);
    assert.deepEqual(origin.S3OriginConfig, { OriginAccessIdentity: '' }, 'no legacy OAI');
  }
  // the bucket policy lets exactly these two distributions read
  const statements = Object.values(t.findResources('AWS::S3::BucketPolicy'))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
    .filter((statement: any) => statement.Principal?.Service === 'cloudfront.amazonaws.com');
  const readers = JSON.stringify(statements.map((statement: any) => statement.Condition.StringEquals['AWS:SourceArn']));
  const distributionIds = Object.keys(t.findResources('AWS::CloudFront::Distribution'));
  assert.equal(distributionIds.length, 2);
  for (const id of distributionIds) assert.match(readers, new RegExp(`"Ref":"${id}"`), `${id} may read the bucket`);
  for (const statement of statements) assert.equal(statement.Action, 's3:GetObject');
});

test('points each origin path at the release it serves, or the placeholder', () => {
  const originPath = (t: Template, id?: string) => distributionConfig(t, id).Origins[0].OriginPath;
  const fresh = synth('dev');
  assert.equal(originPath(fresh), '/releases/initial');
  assert.equal(originPath(fresh, 'IntegrationDistribution'), '/releases/initial');
  const kept = synth('dev', { liveReleaseId: '20261006T120000Z', integrationReleaseId: '20261006T123005Z' });
  assert.equal(originPath(kept), '/releases/20261006T120000Z');
  assert.equal(originPath(kept, 'IntegrationDistribution'), '/releases/20261006T123005Z');
});

test('has no SPA fallback, so a missing file stays a 4xx', () => {
  const t = synth('dev');
  assert.equal(distributionConfig(t).CustomErrorResponses, undefined);
  assert.equal(distributionConfig(t, 'IntegrationDistribution').CustomErrorResponses, undefined);
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
  for (const name of ['DistributionId', 'DistributionDomainName', 'SiteUrl', 'IntegrationDistributionId', 'IntegrationSiteUrl', 'SiteBucketName', 'DeploymentsBucketName', 'DeploymentsTableName']) {
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
