import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { EnvConfig, PROJECT_NAME } from './config.js';
import { INITIAL_RELEASE_ID, originPathFor, releasePrefix } from '../lambda/shared/releases.js';

export interface FrontendUserStackProps extends cdk.StackProps {
  config: EnvConfig;
}

/**
 * Main region: site bucket, the distribution clients use and the integration distribution CI
 * tests on (both read the same releases), deployments bucket and table.
 */
export class FrontendUserStack extends cdk.Stack {
  readonly siteBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly integrationDistribution: cloudfront.Distribution;
  readonly deploymentsBucket: s3.Bucket;
  readonly deploymentsTable: dynamodb.TableV2;
  readonly dashboardApi: NodejsFunction;

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

    // --- Dashboard API ------------------------------------------------------------
    // Data for the dashboard (lambda/dashboard-api), served by both distributions at /api/*. Read-only
    // but for restoring a recorded API deployment, which it hands to the rollback service.
    // The function URL takes IAM auth: only CloudFront, signing through OAC, can call it.
    this.dashboardApi = new NodejsFunction(this, 'DashboardApi', {
      functionName: name('frontend-dashboard-api'),
      description: `Data for the ${config.frontendName} dashboard: API Gateways, Lambda functions, CloudFront distributions; API restores`,
      entry: path.join(__dirname, '..', 'lambda', 'dashboard-api', 'handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // a restore waits for the rollback service to redeploy the API
      timeout: cdk.Duration.seconds(55),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'DashboardApiLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true },
      environment: {
        // finds the deployments table of each frontend-user-<env> distribution and api-user-<env> API,
        // and the rollback service of each environment
        PROJECT_NAME,
        // the functions whose aliases the Lambda panel may point (registered-functions.ts)
        REGISTERED_FUNCTIONS: JSON.stringify(registeredFunctions()),
      },
    });
    // apigateway:GET on the API lists, each API, its stages and its deployments, nothing else.
    // API ids are 10 characters: '??????????' matches one id, where '*' would also match
    // deeper paths (IAM wildcards cross '/'), such as stage exports.
    const apiId = '??????????';
    this.dashboardApi.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [
        '/restapis', `/restapis/${apiId}`, `/restapis/${apiId}/stages`, `/restapis/${apiId}/deployments`,
        '/apis', `/apis/${apiId}`, `/apis/${apiId}/stages`, `/apis/${apiId}/deployments`,
      ].map(
        (resource) => `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}::${resource}`,
      ),
    }));
    // Lambda: list the functions (no resource-level permission), then each one's aliases and
    // versions. Not GetFunction: no code download links, and environment variables are never sent on.
    this.dashboardApi.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:ListFunctions'],
      resources: ['*'],
    }));
    this.dashboardApi.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:ListAliases', 'lambda:ListVersionsByFunction'],
      resources: [`arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:*`],
    }));
    // CloudFront: list the distributions (no resource-level permission), then read one, and its
    // invalidations. Origin custom headers come with GetDistribution and are never sent on.
    this.dashboardApi.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront:ListDistributions'],
      resources: ['*'],
    }));
    this.dashboardApi.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront:GetDistribution', 'cloudfront:ListInvalidations', 'cloudfront:GetInvalidation'],
      resources: [`arn:${cdk.Aws.PARTITION}:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/*`],
    }));
    // The deployment history of every environment's frontend-user distribution and api-user API:
    // Query only, so the dashboard of any environment shows it (tables of environments not deployed
    // just don't exist)
    const table = (prefix: string) => `arn:${cdk.Aws.PARTITION}:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${PROJECT_NAME}-${prefix}-*`;
    this.dashboardApi.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [table('frontend-deployments'), table('deployments')],
    }));
    // Restoring a recorded API deployment: the rollback service re-imports its spec and redeploys
    this.dashboardApi.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:${PROJECT_NAME}-rollback-service-*`],
    }));
    // CloudWatch: the Monitoring tabs' metrics (CloudFront's are read in us-east-1) (GetMetricData has no resource-level permission)
    this.dashboardApi.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricData'],
      resources: ['*'],
    }));
    const dashboardApiUrl = this.dashboardApi.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // --- Distributions ------------------------------------------------------------
    // The origin path selects the release a distribution serves. `cdk deploy` keeps both on
    // -c liveReleaseId / -c integrationReleaseId (scripts/live-context.ts), so a deploy never
    // undoes an activation or a rollback.
    const siteDistribution = (id: string, comment: string, releaseId = INITIAL_RELEASE_ID) => {
      const distribution = new cloudfront.Distribution(this, id, {
        comment,
        defaultRootObject: 'index.html',
        httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket, {
            originPath: originPathFor(releaseId),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          // Hashed assets are cached for a year; HTML is uploaded with Cache-Control: no-cache.
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
          compress: true,
        },
        additionalBehaviors: {
          // the dashboard API: never cached, and the query string and headers reach the Lambda
          // (all but Host, which has to be the function URL's for the signature). POST is for
          // restores (the handler answers 405 to the other methods), and those take a while.
          '/api/*': {
            origin: origins.FunctionUrlOrigin.withOriginAccessControl(dashboardApiUrl, { readTimeout: cdk.Duration.seconds(60) }),
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
            responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
          },
        },
        // No SPA fallback (403/404 -> index.html): the app has two real HTML pages, and a
        // missing file has to stay a 4xx so the 4xx alarm can see a broken release.
      });
      cdk.Tags.of(distribution).add('Name', comment);
      // FunctionUrlOrigin grants lambda:InvokeFunctionUrl; function URLs also need
      // lambda:InvokeFunction, limited here to calls made through the URL
      this.dashboardApi.addPermission(`InvokeFrom${id}`, {
        principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
        action: 'lambda:InvokeFunction',
        sourceArn: distribution.distributionArn,
        invokedViaFunctionUrl: true,
      });
      return distribution;
    };
    // What clients use. Only this one has alarms and is rolled back (alarms stack).
    // Its construct id stays 'Distribution' so existing stacks update it in place.
    this.distribution = siteDistribution('Distribution', config.frontendName, config.liveReleaseId);
    // Where CI makes each release live first and runs the integration tests, like the API's
    // integration stage. No alarms: test traffic never counts toward a rollback.
    this.integrationDistribution = siteDistribution(
      'IntegrationDistribution', config.integrationName, config.integrationReleaseId,
    );

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
      tableName: config.deploymentsTableName,
      partitionKey: { name: 'frontendName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'deployedAt', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config.retainData },
      removalPolicy,
    });

    // --- Outputs --------------------------------------------------------------
    // Export names are unique per account and region, and the api-user stack in the same
    // region exports rollback-factory-demo-<Output>-<env> (e.g. DeploymentsTableName): prefix ours.
    const out = (outputName: string, value: string) =>
      new cdk.CfnOutput(this, outputName, { value, exportName: name(`frontend-${outputName}`) });
    out('DistributionId', this.distribution.distributionId);
    out('DistributionDomainName', this.distribution.distributionDomainName);
    out('SiteUrl', `https://${this.distribution.distributionDomainName}`);
    out('IntegrationDistributionId', this.integrationDistribution.distributionId);
    out('IntegrationSiteUrl', `https://${this.integrationDistribution.distributionDomainName}`);
    out('SiteBucketName', this.siteBucket.bucketName);
    out('DeploymentsBucketName', this.deploymentsBucket.bucketName);
    out('DeploymentsTableName', this.deploymentsTable.tableName);
    // What the rollback service's CloudFront manager needs, as one JSON output it reads at runtime
    // (rollback-service/lambda/managers/cloudfront/manager.ts: CloudFrontRollbackTarget). Only the
    // distribution clients use: the integration distribution is never rolled back.
    out('RollbackTarget', cdk.Stack.of(this).toJsonString({
      frontendName: config.frontendName,
      distributionId: this.distribution.distributionId,
      table: this.deploymentsTable.tableName,
      alarmNames: Object.values(config.alarmNames),
      rollbackWindowMinutes: config.rollbackWindowMinutes,
    }));
  }
}

/**
 * The functions registered for rollback in rollback-service/rollback-config.json, with <env> kept:
 * the dashboard of any environment resolves a name to that environment's rollback service.
 */
export function registeredFunctions(file = path.join(__dirname, '..', '..', 'rollback-service', 'rollback-config.json')) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { functions?: Array<{ name: string; enabled?: boolean; alias?: string }> };
  return (config.functions ?? [])
    .filter((fn) => fn.enabled !== false)
    .map((fn) => ({ name: fn.name, alias: fn.alias ?? 'live' }));
}
