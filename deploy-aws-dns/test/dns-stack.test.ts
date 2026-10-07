import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { siteDomains, ZONE_NAME } from '../lib/config.js';
import { DnsStack } from '../lib/dns-stack.js';

const t = Template.fromStack(new DnsStack(new cdk.App(), 'Test'));

test('one public hosted zone for rollback.ionuteliantudor.com, kept if the stack is deleted', () => {
  t.resourceCountIs('AWS::Route53::HostedZone', 1);
  t.hasResource('AWS::Route53::HostedZone', {
    Properties: { Name: 'rollback.ionuteliantudor.com.' },
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
});

test('outputs the zone id and the name servers to delegate to', () => {
  const outputs = t.findOutputs('*');
  assert.deepEqual(outputs.HostedZoneId.Export, { Name: 'rollback-factory-demo-dns-HostedZoneId' });
  assert.match(JSON.stringify(outputs.NameServers.Value), /NameServers/);
  assert.equal(outputs.ZoneName.Value, ZONE_NAME);
});

test('names each environment\'s sites: prod without a prefix', () => {
  assert.deepEqual(siteDomains('dev'), {
    site: 'dev.rollback.ionuteliantudor.com',
    integration: 'dev-integration.rollback.ionuteliantudor.com',
  });
  assert.deepEqual(siteDomains('prod'), {
    site: 'rollback.ionuteliantudor.com',
    integration: 'integration.rollback.ionuteliantudor.com',
  });
});
