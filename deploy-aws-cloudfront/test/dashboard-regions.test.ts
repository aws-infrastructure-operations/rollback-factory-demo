import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { route } from '../lambda/dashboard-api/handler.js';
import { perRegion, REGIONS, regionList, regionOf } from '../lambda/dashboard-api/regions.js';
import { getConfig } from '../lib/config.js';
import { FrontendUserStack } from '../lib/frontend-user-stack.js';

const query = (qs: string) => new URLSearchParams(qs);

test('?region defaults to the dashboard\'s own region and only takes the regions the picker offers', () => {
  assert.equal(regionOf(query(''), 'eu-central-1'), 'eu-central-1');
  assert.equal(regionOf(query('region=us-east-1'), 'eu-central-1'), 'us-east-1');
  assert.equal(regionOf(query('region=eu-central-1'), 'eu-central-1'), 'eu-central-1');
  for (const bad of ['mars-north-1', 'us-east-1a', '../eu-west-1', 'toString', '__proto__']) {
    assert.equal(regionOf(query(`region=${encodeURIComponent(bad)}`), 'eu-central-1'), undefined, bad);
  }
  // a home region outside the list is still accepted (and listed first)
  assert.equal(regionOf(query('region=me-central-1'), 'me-central-1'), 'me-central-1');
});

test('lists the regions with their names, home first when it isn\'t a default one', () => {
  const list = regionList('eu-central-1');
  assert.equal(list.home, 'eu-central-1');
  assert.deepEqual(list.regions.find((r) => r.code === 'eu-central-1'), { code: 'eu-central-1', name: 'Frankfurt' });
  assert.equal(list.regions.length, Object.keys(REGIONS).length);
  assert.deepEqual(regionList('me-central-1').regions[0], { code: 'me-central-1', name: 'me-central-1' });
});

test('creates one client per region, once', () => {
  let created = 0;
  const clientIn = perRegion((region) => ({ region, n: ++created }));
  assert.equal(clientIn('us-east-1'), clientIn('us-east-1'));
  assert.notEqual(clientIn('us-east-1'), clientIn('eu-west-1'));
  assert.equal(created, 2);
});

const get = (rawPath: string, rawQueryString = '') => route({ rawPath, rawQueryString, requestContext: { http: { method: 'GET' } } });

test('GET /api/regions answers the picker\'s list with the dashboard\'s own region', async () => {
  const saved = process.env.AWS_REGION;
  process.env.AWS_REGION = 'eu-central-1';
  try {
    const res = await get('/api/regions');
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).home, 'eu-central-1');
    assert.equal((await route({ rawPath: '/api/regions', requestContext: { http: { method: 'POST' } } })).statusCode, 405);
    // an unknown region is refused before any AWS call
    for (const path of ['/api/api-gateways', '/api/api-gateways/abc123defg', '/api/lambda-functions', '/api/lambda-functions/fn']) {
      const bad = await get(path, 'type=REST&region=mars-north-1');
      assert.equal(bad.statusCode, 400, path);
      assert.match(JSON.parse(bad.body).message, /Unknown \?region/);
    }
  } finally {
    if (saved === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = saved;
  }
});

test('the dashboard API may read API Gateway and the registered functions in any region, and nothing more', () => {
  const t = Template.fromStack(new FrontendUserStack(new cdk.App(), 'Test', { config: getConfig('dev') }));
  const statements = Object.values(t.findResources('AWS::IAM::Policy'))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  const resourcesOf = (action: string) => statements.filter((s: any) => [s.Action].flat().includes(action))
    .flatMap((s: any) => [s.Resource].flat()).map((r: any) => JSON.stringify(r));
  const apigw = resourcesOf('apigateway:GET');
  assert.ok(apigw.length > 0 && apigw.every((r) => r.includes(':apigateway:*::/')), apigw.join('\n'));
  assert.ok(apigw.every((r) => !r.includes('/exports')), 'no stage exports');
  const aliases = resourcesOf('lambda:ListAliases');
  assert.ok(aliases.length > 0 && aliases.every((r) => r.includes(':lambda:*:')), aliases.join('\n'));
  // the writes stay in the dashboard's own region
  const invoke = resourcesOf('lambda:InvokeFunction');
  assert.ok(invoke.some((r) => r.includes('rollback-service')));
  assert.ok(invoke.every((r) => !r.includes(':lambda:*:')), invoke.join('\n'));
});
