import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { EnvConfig } from './config.js';
import { INITIAL_RELEASE_ID, originPathFor, releasePrefix } from '../lambda/shared/releases.js';

export interface FrontendUserStackProps extends cdk.StackProps {
  config: EnvConfig;
}

/** Main region: site bucket + CloudFront distribution, deployments bucket and table. */
export class FrontendUserStack extends cdk.Stack {
  readonly siteBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly deploymentsBucket: s3.Bucket;
  readonly deploymentsTable: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props: FrontendUserStackProps) {
    super(scope, id, props);
    const { config } = props;
    const name = config.resourceName;
    const removalPolicy = config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // --- Site bucket ------------------------------------------------------------
    // Private: only the distribution reads it, through Origin Access Control. Every release
    // lives under its own releases/<id>/ prefix and is never overwritten, so no versioning.
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: name(`${cdk.Aws.ACCOUNT_ID}-frontend-site`),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !config.retainData,
    });

    // --- Distribution -------------------------------------------------------------
    // The origin path selects the live release. `cdk deploy` keeps it on -c liveReleaseId
    // (scripts/live-context.ts), so a deploy never undoes an activation or a rollback.
    const liveReleaseId = config.liveReleaseId ?? INITIAL_RELEASE_ID;
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: config.frontendName,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket, {
          originPath: originPathFor(liveReleaseId),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        // Hashed assets are cached for a year; HTML is uploaded with Cache-Control: no-cache.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      // No SPA fallback (403/404 -> index.html): the app has two real HTML pages, and a
      // missing file has to stay a 4xx so the 4xx alarm can see a broken release.
    });
    cdk.Tags.of(this.distribution).add('Name', config.frontendName);

    // A fresh stack serves a placeholder until the first release is activated.
    new s3deploy.BucketDeployment(this, 'InitialRelease', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'site-placeholder'))],
      destinationBucket: this.siteBucket,
      destinationKeyPrefix: `${releasePrefix(INITIAL_RELEASE_ID)}/`,
      cacheControl: [s3deploy.CacheControl.noCache()],
      prune: false,
    });

    // --- Deployment tracking ----------------------------------------------------
    // One build manifest per release, under <frontendName>/<releaseId>/manifest.json
    // (see lambda/shared/releases.ts). Versioned, like the API's deployments bucket.
    this.deploymentsBucket = new s3.Bucket(this, 'DeploymentsBucket', {
      bucketName: name(`${cdk.Aws.ACCOUNT_ID}-frontend-deployments`),
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !config.retainData,
    });

    // One item per activation, restore or rollback (see lambda/shared/deployments.ts):
    // pk = frontendName, sk = deployedAt (ISO 8601), newest first via ScanIndexForward=false.
    this.deploymentsTable = new dynamodb.TableV2(this, 'DeploymentsTable', {
      tableName: name('frontend-deployments'),
      partitionKey: { name: 'frontendName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'deployedAt', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config.retainData },
      removalPolicy,
    });

    // --- Outputs --------------------------------------------------------------
    const out = (outputName: string, value: string) =>
      new cdk.CfnOutput(this, outputName, { value, exportName: name(outputName) });
    out('DistributionId', this.distribution.distributionId);
    out('DistributionDomainName', this.distribution.distributionDomainName);
    out('SiteUrl', `https://${this.distribution.distributionDomainName}`);
    out('SiteBucketName', this.siteBucket.bucketName);
    out('DeploymentsBucketName', this.deploymentsBucket.bucketName);
    out('DeploymentsTableName', this.deploymentsTable.tableName);
  }
}
