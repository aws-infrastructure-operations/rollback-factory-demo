import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { siteDomains as dnsSiteDomains, ZONE_NAME } from '../../deploy-aws-dns/lib/config.js';
import { getConfig, HOSTED_ZONE, siteDomains } from '../lib/config.js';
import { createFrontendStacks } from '../lib/frontend-app.js';

const synth = (env: string) => {
  const app = new cdk.App();
  const stacks = createFrontendStacks(app, getConfig(env, {}), { account: '123456789012', region: 'eu-central-1' });
  return {
    stacks,
    certificate: Template.fromStack(stacks.certificate),
    main: Template.fromStack(stacks.main),
  };
};

test('names the sites like deploy-aws-dns: dev with a prefix, prod without', () => {
  for (const env of ['dev', 'prod']) assert.deepEqual(siteDomains(env), dnsSiteDomains(env), env);
  assert.equal(HOSTED_ZONE.name, ZONE_NAME);
  assert.deepEqual(siteDomains('prod'), { site: 'rollback.ionuteliantudor.com', integration: 'integration.rollback.ionuteliantudor.com' });
});

test('one certificate in us-east-1 for the environment\'s two domains, validated in the zone', () => {
  for (const env of ['dev', 'prod']) {
    const { stacks, certificate } = synth(env);
    assert.equal(stacks.certificate.region, 'us-east-1');
    assert.equal(stacks.certificate.stackName, `deploy-aws-cloudfront-certificate-${env}`);
    const { site, integration } = siteDomains(env);
    certificate.resourceCountIs('AWS::CertificateManager::Certificate', 1);
    certificate.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: site,
      SubjectAlternativeNames: [integration],
      ValidationMethod: 'DNS',
      DomainValidationOptions: [
        { DomainName: site, HostedZoneId: HOSTED_ZONE.id },
        { DomainName: integration, HostedZoneId: HOSTED_ZONE.id },
      ],
    });
  }
});

test('each distribution serves its domain with the certificate, TLS 1.2 at least', () => {
  const { main } = synth('dev');
  const configs = Object.entries(main.findResources('AWS::CloudFront::Distribution'))
    .map(([id, r]: [string, any]) => [id.startsWith('Integration') ? 'integration' : 'site', r.Properties.DistributionConfig] as const);
  assert.equal(configs.length, 2);
  for (const [which, config] of configs) {
    assert.deepEqual(config.Aliases, [siteDomains('dev')[which]]);
    assert.equal(config.ViewerCertificate.MinimumProtocolVersion, 'TLSv1.2_2021');
    assert.equal(config.ViewerCertificate.SslSupportMethod, 'sni-only');
    // the certificate's ARN, read across regions from the us-east-1 stack
    assert.match(JSON.stringify(config.ViewerCertificate.AcmCertificateArn), /SiteCertificate/);
  }
});

test('A and AAAA alias records point each domain at its distribution, in the shared zone', () => {
  const { main } = synth('prod');
  const records = Object.values(main.findResources('AWS::Route53::RecordSet')).map((r: any) => r.Properties);
  assert.deepEqual(records.map((r) => `${r.Type} ${r.Name}`).sort(), [
    'A integration.rollback.ionuteliantudor.com.', 'A rollback.ionuteliantudor.com.',
    'AAAA integration.rollback.ionuteliantudor.com.', 'AAAA rollback.ionuteliantudor.com.',
  ]);
  for (const r of records) {
    assert.equal(r.HostedZoneId, HOSTED_ZONE.id);
    assert.match(JSON.stringify(r.AliasTarget.DNSName), /Distribution/);
  }
  // the zone itself belongs to deploy-aws-dns: never created (or deleted) here
  main.resourceCountIs('AWS::Route53::HostedZone', 0);
});

test('the site URLs are the custom domains; the cloudfront.net ones stay as outputs', () => {
  const { main } = synth('dev');
  const outputs = main.findOutputs('*');
  assert.equal(outputs.SiteUrl.Value, 'https://dev.rollback.ionuteliantudor.com');
  assert.equal(outputs.IntegrationSiteUrl.Value, 'https://dev-integration.rollback.ionuteliantudor.com');
  assert.ok(outputs.DistributionDomainName && outputs.IntegrationDistributionDomainName);
});

test('deploys the certificate first and keeps the distribution\'s construct id (updated in place)', () => {
  const { stacks, main } = synth('dev');
  assert.ok(stacks.main.dependencies.includes(stacks.certificate));
  assert.ok(stacks.alarms.dependencies.includes(stacks.main));
  main.hasResource('AWS::CloudFront::Distribution', Match.anyValue());
  assert.ok(Object.keys(main.findResources('AWS::CloudFront::Distribution')).some((id) => /^Distribution[0-9A-F]{8}$/.test(id)));
});
