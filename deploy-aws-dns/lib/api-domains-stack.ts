import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { API_DOMAIN_ENVS, apiDomain, PROJECT_NAME } from './config.js';

export interface ApiDomainsStackProps extends cdk.StackProps {
  zone: route53.IHostedZone;
}

/**
 * One API Gateway custom domain per environment (apiDomain()), shared by every API of that
 * environment: each API's stack maps its stages on it under its own path, e.g.
 * api.dev.rollback…/user/v1 -> api-user-dev, stage v1 (deploy-aws-api-gateway/lib/config.ts: API_PATH).
 *
 * The domains live here, not in an API's stack, because they belong to no single API, and because
 * cleanup.yml destroys an environment's API stacks: their mappings go with them, the domain stays.
 *
 * Regional endpoint and TLS 1.2: multi-level mappings (`user/v1`) need both. A regional domain only
 * serves APIs of its region, so this stack must be in the APIs' region (vars.AWS_REGION).
 */
export class ApiDomainsStack extends cdk.Stack {
  readonly domains: Record<string, apigw.DomainName> = {};

  constructor(scope: Construct, id: string, props: ApiDomainsStackProps) {
    super(scope, id, props);
    const { zone } = props;

    for (const env of API_DOMAIN_ENVS) {
      const domainName = apiDomain(env);
      const key = `${env[0].toUpperCase()}${env.slice(1)}`;
      const certificate = new acm.Certificate(this, `${key}Certificate`, {
        domainName,
        certificateName: `${PROJECT_NAME}-api-domain-${env}`,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      const domain = new apigw.DomainName(this, `${key}ApiDomain`, {
        domainName,
        certificate,
        endpointType: apigw.EndpointType.REGIONAL,
        securityPolicy: apigw.SecurityPolicy.TLS_1_2,
      });
      this.domains[env] = domain;

      // the domain points at the API Gateway domain, over IPv4 and IPv6
      const target = route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayDomain(domain));
      new route53.ARecord(this, `${key}AliasA`, { zone, recordName: domainName, target });
      new route53.AaaaRecord(this, `${key}AliasAaaa`, { zone, recordName: domainName, target });

      new cdk.CfnOutput(this, `${key}ApiDomainName`, {
        value: domainName,
        description: `APIs of ${env}: https://${domainName}/<api path>/<stage>/...`,
      });
    }
  }
}
