import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CloudFrontClient, GetDistributionCommand, GetInvalidationCommand, ListDistributionsCommand, ListInvalidationsCommand,
} from '@aws-sdk/client-cloudfront';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  deploymentsTableFor, getDistributionDetails, getDistributionMetrics, listDistributions, listInvalidations,
} from '../lambda/dashboard-api/cloudfront-distributions.js';
import { handler } from '../lambda/dashboard-api/handler.js';

const date = (iso: string) => new Date(iso);

const siteOrigin = { Id: 'site', DomainName: 'site.s3.eu-central-1.amazonaws.com', OriginPath: '/releases/20261006T120000Z' };
const apiOrigin = {
  Id: 'api', DomainName: 'abc123.lambda-url.eu-central-1.on.aws', OriginPath: '',
  CustomHeaders: { Quantity: 1, Items: [{ HeaderName: 'x-origin-secret', HeaderValue: 'never sent' }] },
};
const live = {
  Id: 'E1LIVE0000000', DomainName: 'd111.cloudfront.net', Status: 'Deployed', LastModifiedTime: date('2026-10-06T12:05:00Z'),
  Comment: 'frontend-user-dev', Enabled: true, Aliases: { Quantity: 0 }, Origins: { Quantity: 2, Items: [apiOrigin, siteOrigin] },
};
const other = {
  Id: 'E2OTHER000000', DomainName: 'd222.cloudfront.net', Status: 'InProgress', LastModifiedTime: date('2026-10-07T08:00:00Z'),
  Comment: '', Enabled: true, Aliases: { Quantity: 1, Items: ['www.example.com'] },
  Origins: { Quantity: 1, Items: [{ Id: 'web', DomainName: 'example-bucket.s3.amazonaws.com', OriginPath: '' }] },
};

const fakeCloudFront = () => ({
  send: async (command: any) => {
    if (command instanceof ListDistributionsCommand) {
      return command.input.Marker
        ? { DistributionList: { Items: [other], IsTruncated: false } }
        : { DistributionList: { Items: [live], IsTruncated: true, NextMarker: 'm2' } };
    }
    if (command instanceof GetDistributionCommand) {
      const d = [live, other].find((x) => x.Id === command.input.Id);
      if (!d) throw Object.assign(new Error('The specified distribution does not exist.'), { name: 'NoSuchDistribution' });
      const { Id, DomainName, Status, LastModifiedTime, ...config } = d;
      return { Distribution: {
        Id, DomainName, Status, LastModifiedTime,
        DistributionConfig: { ...config, DefaultRootObject: 'index.html', PriceClass: 'PriceClass_100', CacheBehaviors: { Quantity: 1, Items: [{ PathPattern: '/api/*' }] } },
      } };
    }
    if (command instanceof ListInvalidationsCommand) {
      return { InvalidationList: { Items: [
        { Id: 'I2', Status: 'InProgress', CreateTime: date('2026-10-07T08:00:00Z') },
        { Id: 'I1', Status: 'Completed', CreateTime: date('2026-10-06T12:05:00Z') },
      ] } };
    }
    if (command instanceof GetInvalidationCommand) {
      return { Invalidation: { InvalidationBatch: { Paths: { Quantity: 1, Items: [command.input.Id === 'I2' ? '/index.html' : '/*'] } } } };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  },
}) as unknown as CloudFrontClient;

const records = [
  { frontendName: 'frontend-user-dev', deployedAt: '2026-10-06T12:05:00Z', releaseId: '20261006T120000Z', distributionId: 'E1LIVE0000000', source: 'cicd', actor: 'ci', commit: '74f6e80', current: true, verifiedAt: '2026-10-06T12:10:00Z' },
  { frontendName: 'frontend-user-dev', deployedAt: '2026-10-05T09:00:00Z', releaseId: '20261005T085500Z', distributionId: 'E1LIVE0000000', source: 'cicd', actor: 'ci', stable: false, rolledBackAt: '2026-10-05T09:20:00Z' },
  // a distribution recreated under the same name: not this one's history
  { frontendName: 'frontend-user-dev', deployedAt: '2026-09-01T00:00:00Z', releaseId: '20260901T000000Z', distributionId: 'EOLD000000000', source: 'manual', actor: 'me' },
];

const fakeDynamo = (tables: Record<string, any[]>) => {
  const queried: string[] = [];
  const client = {
    send: async (command: any) => {
      assert.ok(command instanceof QueryCommand);
      const table = command.input.TableName!;
      queried.push(table);
      const items = tables[table];
      if (!items) throw Object.assign(new Error('Requested resource not found'), { name: 'ResourceNotFoundException' });
      return { Items: items };
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, queried };
};

test('lists every distribution over the pages, latest change first, with the release it serves', async () => {
  assert.deepEqual(await listDistributions(fakeCloudFront()), [
    { id: 'E2OTHER000000', name: 'E2OTHER000000', domain: 'd222.cloudfront.net', aliases: ['www.example.com'], status: 'InProgress', enabled: true, lastModified: '2026-10-07T08:00:00.000Z' },
    { id: 'E1LIVE0000000', name: 'frontend-user-dev', domain: 'd111.cloudfront.net', aliases: [], status: 'Deployed', enabled: true, releaseId: '20261006T120000Z', lastModified: '2026-10-06T12:05:00.000Z' },
  ]);
});

test('finds the deployments table of frontend-user-<env> distributions only', () => {
  assert.equal(deploymentsTableFor('frontend-user-prod', 'rollback-factory-demo'), 'rollback-factory-demo-frontend-deployments-prod');
  assert.equal(deploymentsTableFor('frontend-user-dev-integration', 'rollback-factory-demo'), undefined);
  assert.equal(deploymentsTableFor('', 'rollback-factory-demo'), undefined);
});

test('details of a project distribution: its release history and configuration, never origin headers', async () => {
  const { client, queried } = fakeDynamo({ 'rollback-factory-demo-frontend-deployments-dev': records });
  const details = await getDistributionDetails(fakeCloudFront(), client, 'E1LIVE0000000', 'rollback-factory-demo');
  assert.deepEqual(queried, ['rollback-factory-demo-frontend-deployments-dev']);
  assert.equal(details!.tracked, true);
  assert.deepEqual(details!.deployments.map((d) => [d.releaseId, d.current, d.verified, d.rolledBack]), [
    ['20261006T120000Z', true, true, false],
    ['20261005T085500Z', false, false, true],
  ]);
  const config = Object.fromEntries(details!.configuration.map((c) => [c.label, c.value]));
  assert.equal(config.Release, '20261006T120000Z');
  assert.equal(config['Origin 1'], 'abc123.lambda-url.eu-central-1.on.aws (dashboard API)');
  assert.equal(config['Origin 2'], 'site.s3.eu-central-1.amazonaws.com/releases/20261006T120000Z');
  assert.equal(config['Path patterns'], '/api/*');
  assert.doesNotMatch(JSON.stringify(details), /never sent|x-origin-secret/);
});

test('details of another distribution: no history, and no table queried', async () => {
  const { client, queried } = fakeDynamo({});
  const details = await getDistributionDetails(fakeCloudFront(), client, 'E2OTHER000000', 'rollback-factory-demo');
  assert.equal(details!.tracked, false);
  assert.deepEqual(details!.deployments, []);
  assert.deepEqual(queried, []);
});

test('a project distribution of an environment without a table is untracked, not an error', async () => {
  const details = await getDistributionDetails(fakeCloudFront(), fakeDynamo({}).client, 'E1LIVE0000000', 'rollback-factory-demo');
  assert.equal(details!.tracked, false);
});

test('details of a distribution that does not exist are undefined', async () => {
  assert.equal(await getDistributionDetails(fakeCloudFront(), fakeDynamo({}).client, 'E9MISSING0000', 'rollback-factory-demo'), undefined);
});

test('lists the latest invalidations with their paths', async () => {
  assert.deepEqual(await listInvalidations(fakeCloudFront(), 'E1LIVE0000000'), [
    { id: 'I2', status: 'InProgress', createdAt: '2026-10-07T08:00:00.000Z', paths: ['/index.html'] },
    { id: 'I1', status: 'Completed', createdAt: '2026-10-06T12:05:00.000Z', paths: ['/*'] },
  ]);
});

test('reads 24 hours of CloudFront metrics with the Global region dimension', async () => {
  let input: any;
  const cloudwatch = {
    send: async (command: any) => {
      input = command.input;
      return { MetricDataResults: [
        { Id: 'requests', Values: [5000] },
        { Id: 'bytes', Values: [1048576] },
        { Id: 'rate4xx', Values: [1, 2, 0.5] },
        { Id: 'rate5xx', Values: [0, 0, 0] },
      ] };
    },
  } as unknown as CloudWatchClient;
  const metrics = await getDistributionMetrics(cloudwatch, 'E1LIVE0000000', new Date('2026-10-07T12:00:00Z'));
  assert.deepEqual(metrics, {
    from: '2026-10-06T12:00:00.000Z', to: '2026-10-07T12:00:00.000Z',
    requests: 5000, bytesDownloaded: 1048576, error4xxRate: 1.17, error5xxRate: 0,
  });
  assert.deepEqual(input.MetricDataQueries[0].MetricStat.Metric.Dimensions, [
    { Name: 'DistributionId', Value: 'E1LIVE0000000' }, { Name: 'Region', Value: 'Global' },
  ]);
});

test('no error rates without traffic', async () => {
  const cloudwatch = { send: async () => ({ MetricDataResults: [] }) } as unknown as CloudWatchClient;
  const metrics = await getDistributionMetrics(cloudwatch, 'E1LIVE0000000');
  assert.equal(metrics.requests, 0);
  assert.equal(metrics.error4xxRate, undefined);
});

test('rejects malformed distribution ids', async () => {
  const get = (rawPath: string) => handler({ rawPath, requestContext: { http: { method: 'GET' } } });
  assert.equal((await get('/api/cloudfront-distributions/e1-lower')).statusCode, 400);
  assert.equal((await get('/api/cloudfront-distributions/E1LIVE0000000/origins')).statusCode, 404);
});
