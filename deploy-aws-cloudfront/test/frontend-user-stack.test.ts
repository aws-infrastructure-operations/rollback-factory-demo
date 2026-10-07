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
  const comparable = (config: any) => ({
    ...config, Comment: undefined, Origins: undefined,
    DefaultCacheBehavior: { ...config.DefaultCacheBehavior, TargetOriginId: undefined },
    CacheBehaviors: config.CacheBehaviors.map((behavior: any) => ({ ...behavior, TargetOriginId: undefined })),
  });
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
  const s3Controls = Object.values(t.findResources('AWS::CloudFront::OriginAccessControl', {
    Properties: { OriginAccessControlConfig: { OriginAccessControlOriginType: 's3', SigningBehavior: 'always' } },
  }));
  assert.equal(s3Controls.length, 2);
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

test('publishes the RollbackTarget the rollback service reads, for the live distribution only', () => {
  const target = JSON.stringify(synth('dev').findOutputs('RollbackTarget').RollbackTarget.Value);
  assert.ok(target.includes('rollback-factory-demo-cloudfront-frontend-user-4xx-rate-dev'));
  assert.ok(target.includes('frontend-user-dev'));
  assert.ok(target.includes('rollbackWindowMinutes\\":30'));
  assert.match(target, /"Ref":"Distribution[0-9A-F]{8}"/);
  assert.doesNotMatch(target, /IntegrationDistribution/);
});

test('never exports a name the api-user stack in the same region could use', () => {
  // the API exports rollback-factory-demo-<Output>-<env>; export names are unique per region
  for (const [name, output] of Object.entries(synth('dev').findOutputs('*'))) {
    const exportName = (output as any).Export?.Name;
    if (exportName) assert.match(exportName, /^rollback-factory-demo-frontend-/, name);
  }
});

test('serves the dashboard API at /api/* on both distributions, uncached, signed with OAC, POST allowed for restores', () => {
  const t = synth('dev');
  for (const id of ['Distribution', 'IntegrationDistribution']) {
    const config = distributionConfig(t, id);
    const [site, api] = config.Origins;
    assert.ok(site.S3OriginConfig, 'the site bucket stays the first origin');
    assert.ok(api.CustomOriginConfig && api.OriginAccessControlId, `${id}: function URL origin with OAC`);
    assert.equal(api.OriginPath, undefined, 'only the site origin has a release path');
    const [behavior] = config.CacheBehaviors;
    assert.equal(behavior.PathPattern, '/api/*');
    assert.equal(behavior.TargetOriginId, api.Id);
    assert.equal(behavior.ViewerProtocolPolicy, 'https-only');
    assert.deepEqual([...behavior.AllowedMethods].sort(), ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
    assert.equal(api.CustomOriginConfig.OriginReadTimeout, 60, 'a restore waits for the redeploy');
    // the managed CachingDisabled policy
    assert.equal(behavior.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  }
  t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 4);
  t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
    OriginAccessControlConfig: { OriginAccessControlOriginType: 'lambda', SigningBehavior: 'always' },
  });
});

test('lets only the two distributions call the dashboard API, through its IAM-auth function URL', () => {
  const t = synth('dev');
  t.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'rollback-factory-demo-frontend-dashboard-api-dev' });
  t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  const permissions = Object.values(t.findResources('AWS::Lambda::Permission')).map((p: any) => p.Properties);
  for (const action of ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction']) {
    const granted = permissions.filter((p) => p.Action === action);
    assert.equal(granted.length, 2, action);
    for (const p of granted) assert.equal(p.Principal, 'cloudfront.amazonaws.com');
    const sources = JSON.stringify(granted.map((p) => p.SourceArn));
    for (const id of Object.keys(t.findResources('AWS::CloudFront::Distribution'))) {
      assert.match(sources, new RegExp(`"Ref":"${id}"`), `${action} for ${id}`);
    }
  }
  for (const p of permissions.filter((p) => p.Action === 'lambda:InvokeFunction')) assert.equal(p.InvokedViaFunctionUrl, true);
});

test('gives the dashboard API read access to the APIs, their stages and deployments only', () => {
  const statements = Object.values(synth('dev').findResources('AWS::IAM::Policy'))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
    .filter((statement: any) => JSON.stringify(statement.Action).includes('apigateway'));
  assert.equal(statements.length, 1);
  assert.equal(statements[0].Action, 'apigateway:GET');
  const resources = JSON.stringify(statements[0].Resource);
  const expected = ['/restapis', '/apis'].flatMap((list) =>
    [list, `${list}/??????????`, `${list}/??????????/stages`, `${list}/??????????/deployments`]);
  for (const path of expected) assert.ok(resources.includes(`::${path}"`), path);
  assert.equal(statements[0].Resource.length, expected.length);
  assert.doesNotMatch(resources, /\*/,'no wildcard that crosses into deeper paths');
});

test('lets the dashboard API list and read (API Gateway, Lambda, CloudFront, deployment history, metrics) and invoke the rollback service only', () => {
  const t = synth('dev');
  const [roleId] = Object.keys(t.findResources('AWS::IAM::Role')).filter((id) => id.startsWith('DashboardApi'));
  const statements = Object.values(t.findResources('AWS::IAM::Policy'))
    .filter((policy: any) => JSON.stringify(policy.Properties.Roles).includes(`"${roleId}"`))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
  const actions = statements.flatMap((s: any) => [s.Action].flat()).sort();
  assert.deepEqual(actions, [
    'apigateway:GET', 'cloudfront:GetDistribution', 'cloudfront:GetInvalidation', 'cloudfront:ListDistributions',
    'cloudfront:ListInvalidations', 'cloudwatch:GetMetricData', 'dynamodb:Query',
    'lambda:InvokeFunction', 'lambda:ListAliases', 'lambda:ListFunctions', 'lambda:ListVersionsByFunction', 's3:GetObject',
  ]);
  const query = statements.find((s: any) => s.Action === 'dynamodb:Query');
  assert.equal(query.Resource.length, 2);
  assert.match(JSON.stringify(query.Resource), /:table\/rollback-factory-demo-frontend-deployments-\*"/, 'the frontend deployments tables');
  assert.match(JSON.stringify(query.Resource), /:table\/rollback-factory-demo-deployments-\*"/, 'the API deployments tables');
  const invoke = statements.find((s: any) => s.Action === 'lambda:InvokeFunction');
  assert.match(JSON.stringify(invoke.Resource), /:function:rollback-factory-demo-rollback-service-\*"\]\]}$/, 'the rollback services only');
  const scoped = statements.find((s: any) => [s.Action].flat().includes('lambda:ListAliases'));
  // the functions registered for rollback only (<env> -> *), of this account and region
  const scopedTo = JSON.stringify(scoped.Resource);
  for (const fn of ['service-lambda-*', 'rollback-factory-demo-api-users-*', 'rollback-factory-demo-api-messages-*']) {
    assert.ok(scopedTo.includes(`:function:${fn}"`), fn);
  }
  assert.equal(scoped.Resource.length, 3, 'aliases and versions of the registered functions only');
  // the api-user OpenAPI exports in the API deployments buckets, nothing else of them
  const specs = statements.find((s: any) => s.Action === 's3:GetObject');
  assert.match(JSON.stringify(specs.Resource), /-deployments-\*\/api-user-\*\/openapi\.json"\]\]}$/);
});
