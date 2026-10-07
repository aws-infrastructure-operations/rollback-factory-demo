import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiDomainsStack } from '../lib/api-domains-stack.js';
import { apiDomain } from '../lib/config.js';
import { DnsStack } from '../lib/dns-stack.js';

const app = new cdk.App();
const env = { account: '123456789012', region: 'eu-central-1' };
const dns = new DnsStack(app, 'Dns', { env });
const t = Template.fromStack(new ApiDomainsStack(app, 'ApiDomains', { env, zone: dns.zone }));

test('names each environment\'s API domain: prod without a prefix', () => {
  assert.equal(apiDomain('dev'), 'api.dev.rollback.ionuteliantudor.com');
  assert.equal(apiDomain('prod'), 'api.rollback.ionuteliantudor.com');
});

test('one regional TLS 1.2 custom domain per environment (multi-level mappings need both)', () => {
  t.resourceCountIs('AWS::ApiGateway::DomainName', 2);
  for (const env of ['dev', 'prod']) {
    t.hasResourceProperties('AWS::ApiGateway::DomainName', {
      DomainName: apiDomain(env),
      EndpointConfiguration: { Types: ['REGIONAL'] },
      SecurityPolicy: 'TLS_1_2',
      RegionalCertificateArn: Match.anyValue(),
    });
  }
});

test('a DNS-validated certificate per domain, in the zone', () => {
  t.resourceCountIs('AWS::CertificateManager::Certificate', 2);
  for (const env of ['dev', 'prod']) {
    t.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: apiDomain(env),
      ValidationMethod: 'DNS',
      DomainValidationOptions: [{ DomainName: apiDomain(env), HostedZoneId: Match.anyValue() }],
    });
  }
});

test('A and AAAA alias records point each domain at its API Gateway domain', () => {
  for (const type of ['A', 'AAAA']) {
    for (const env of ['dev', 'prod']) {
      t.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: `${apiDomain(env)}.`,
        Type: type,
        AliasTarget: { DNSName: Match.anyValue(), HostedZoneId: Match.anyValue() },
      });
    }
  }
});

test('creates no base path mappings: each API stack maps itself', () => {
  t.resourceCountIs('AWS::ApiGateway::BasePathMapping', 0);
  t.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 0);
});
