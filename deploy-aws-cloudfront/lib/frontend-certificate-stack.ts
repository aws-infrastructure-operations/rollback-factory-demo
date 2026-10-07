import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvConfig } from './config.js';

export interface FrontendCertificateStackProps extends cdk.StackProps {
  config: EnvConfig;
}

/**
 * us-east-1: the TLS certificate of an environment's two sites (CloudFront only takes certificates
 * from us-east-1), e.g. dev.rollback.ionuteliantudor.com and dev-integration.rollback.ionuteliantudor.com.
 * Validated by DNS in the hosted zone of deploy-aws-dns: CloudFormation adds the validation records and
 * waits until ACM issues it, so the zone must be delegated before the first deploy. ACM renews it
 * on its own while those records stay.
 */
export class FrontendCertificateStack extends cdk.Stack {
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: FrontendCertificateStackProps) {
    super(scope, id, props);
    const { config } = props;
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: config.hostedZone.id,
      zoneName: config.hostedZone.name,
    });

    this.certificate = new acm.Certificate(this, 'SiteCertificate', {
      certificateName: config.resourceName('frontend-sites'),
      domainName: config.domains.site,
      subjectAlternativeNames: [config.domains.integration],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    new cdk.CfnOutput(this, 'CertificateArn', { value: this.certificate.certificateArn });
  }
}
