import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { PARENT_DOMAIN, PROJECT_NAME, ZONE_NAME } from './config.js';

/**
 * The Route 53 hosted zone for rollback.ionuteliantudor.com, shared by every environment: the
 * frontend stacks add their certificates' validation records and their sites' alias records to it.
 *
 * It lives in its own project because the cleanup workflow destroys an environment's stacks with
 * `cdk destroy --all`: destroying dev must never take the zone prod uses. The zone is kept even if
 * this stack is deleted, so its name servers (and the delegation to them) never change.
 *
 * One-time step after the first deploy: delegate the zone from ionuteliantudor.com's DNS host by
 * adding an NS record for "rollback" with the four name servers this stack outputs.
 */
export class DnsStack extends cdk.Stack {
  readonly zone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.zone = new route53.PublicHostedZone(this, 'RollbackZone', {
      zoneName: ZONE_NAME,
      comment: `${PROJECT_NAME}: the CloudFront sites of every environment (delegated from ${PARENT_DOMAIN})`,
    });
    this.zone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.zone.hostedZoneId,
      description: 'Goes into deploy-aws-cloudfront/lib/config.ts (HOSTED_ZONE_ID)',
      exportName: `${PROJECT_NAME}-dns-HostedZoneId`,
    });
    new cdk.CfnOutput(this, 'ZoneName', { value: ZONE_NAME });
    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(',', this.zone.hostedZoneNameServers!),
      description: `Add an NS record for "rollback" with these four values at ${PARENT_DOMAIN}'s DNS host`,
    });
  }
}
