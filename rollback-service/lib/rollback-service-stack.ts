import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import rollbackConfig from '../rollback-config.json';
import { resolveRegistry } from '../lambda/managers/lambda/registry.js';
import { ALARM_TYPES, EDGE_REGION, EnvConfig, LAMBDA_ROLLBACK_SETTINGS, PROJECT_NAME } from './config.js';

/**
 * The topic rollback alarms publish to, with the explicit CloudWatch allow that enforceSSL needs
 * (its policy replaces the default one). Any rollback-factory-demo-* alarm of this account in the
 * topic's region may publish: the router checks the name.
 */
export function rollbackTopic(scope: Construct, config: EnvConfig) {
  const stack = cdk.Stack.of(scope);
  const topic = new sns.Topic(scope, 'RollbackTopic', {
    topicName: config.topicName,
    displayName: `rollback-factory-demo ${config.envName} rollbacks`,
    enforceSSL: true,
  });
  topic.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'AllowCloudWatchAlarms',
    principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
    actions: ['sns:Publish'],
    resources: [topic.topicArn],
    conditions: {
      StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
      ArnLike: {
        'aws:SourceArn': stack.formatArn({
          service: 'cloudwatch', resource: 'alarm', resourceName: `${PROJECT_NAME}-*`, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      },
    },
  }));
  if (config.alarmEmail) topic.addSubscription(new snsSubs.EmailSubscription(config.alarmEmail));
  new cdk.CfnOutput(scope, 'TopicArn', { value: topic.topicArn, exportName: config.resourceName('rollback-service-TopicArn') });
  return topic;
}

/** us-east-1: the topic the CloudFront alarms publish to (CloudFront metrics, and alarms, only exist there). */
export class RollbackServiceEdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { config: EnvConfig }) {
    super(scope, id, props);
    rollbackTopic(this, props.config);
  }
}

export interface RollbackServiceStackProps extends cdk.StackProps {
  config: EnvConfig;
}

/**
 * Main region: the one rollback Lambda, subscribed to both topics, with the Lambda manager's
 * version archive and scoped role, the scheduled check, and access to each manager's targets.
 */
export class RollbackServiceStack extends cdk.Stack {
  readonly service: NodejsFunction;

  constructor(scope: Construct, id: string, props: RollbackServiceStackProps) {
    super(scope, id, props);
    const { config } = props;
    const name = config.resourceName;
    const env = config.envName;
    const removalPolicy = config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const arn = (service: string, resource: string, resourceName: string, region?: string) => this.formatArn({
      service, resource, resourceName, region, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });

    const topic = rollbackTopic(this, config);

    // --- Lambda manager: version archive -----------------------------------------------
    // Metadata of every published version of every registered function, plus a CURRENT item per
    // function. functionName = <fn>, sk = VERSION#0000000003 | CURRENT
    const versionsTable = new dynamodb.TableV2(this, 'VersionsTable', {
      tableName: config.versionsTableName,
      partitionKey: { name: 'functionName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config.retainData },
      removalPolicy,
    });
    // Package of every archived version, as <fn>/<fn>-<version>.zip. Rollbacks restore $LATEST from here.
    // (Not deploy-aws-lambda's old ...-lambda-artifacts-<env> name, which prod keeps.)
    const artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: name(`${cdk.Aws.ACCOUNT_ID}-lambda-archive`),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !config.retainData,
    });

    // --- The rollback Lambda ----------------------------------------------------------
    this.service = new NodejsFunction(this, 'RollbackService', {
      functionName: config.functionName,
      description: `Rolls back API Gateway, CloudFront and Lambda deployments of ${env}, picking the manager from the alarm name`,
      entry: path.join(__dirname, '..', 'lambda', 'handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // archiving Lambda packages, restoring $LATEST, re-importing an API spec
      timeout: cdk.Duration.minutes(2),
      // Lambda packages are held in memory while being copied to S3
      memorySize: 512,
      retryAttempts: 0,
      logGroup: new logs.LogGroup(this, 'RollbackServiceLogs', {
        // fixed, so the dashboard can show a restore's lines while it runs
        logGroupName: config.logGroupName,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true },
      environment: {
        ENV_NAME: env,
        VERSIONS_TABLE_NAME: versionsTable.tableName,
        VERSIONS_TABLE_ARN: versionsTable.tableArn,
        ARTIFACTS_BUCKET_NAME: artifactsBucket.bucketName,
        ROLLBACK_COOLDOWN_MINUTES: String(LAMBDA_ROLLBACK_SETTINGS.cooldownMinutes),
        STABLE_AFTER_MINUTES: String(LAMBDA_ROLLBACK_SETTINGS.stableAfterMinutes),
        LIVE_ERRORS_LOOKBACK_MINUTES: String(LAMBDA_ROLLBACK_SETTINGS.liveErrorsLookbackMinutes),
        FUNCTION_ARN_PREFIX: `arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:`,
      },
    });

    // Alarms of the main region (API Gateway, Lambda) and of us-east-1 (CloudFront).
    topic.addSubscription(new snsSubs.LambdaSubscription(this.service));
    // Cross-region subscription to the us-east-1 topic (RollbackServiceEdgeStack, deployed first).
    // Declared directly: LambdaSubscription can't tell the region of a topic ARN with tokens in it.
    const edgeTopicArn = this.formatArn({ service: 'sns', region: EDGE_REGION, resource: config.topicName });
    new sns.CfnSubscription(this, 'EdgeTopicSubscription', {
      topicArn: edgeTopicArn,
      protocol: 'lambda',
      endpoint: this.service.functionArn,
      region: EDGE_REGION,
    });
    this.service.addPermission('EdgeTopicInvoke', {
      principal: new iam.ServicePrincipal('sns.amazonaws.com'),
      sourceArn: edgeTopicArn,
    });

    // Every few minutes: the Lambda manager syncs its registered functions, marks stable versions
    // and re-checks alarms still in ALARM (CloudWatch only notifies on state changes).
    new events.Rule(this, 'ScheduledCheck', {
      ruleName: name('rollback-service-check'),
      description: `Every ${LAMBDA_ROLLBACK_SETTINGS.checkIntervalMinutes} min: Lambda rollback manager sync, stable marking, alarm re-check`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(LAMBDA_ROLLBACK_SETTINGS.checkIntervalMinutes)),
      targets: [new targets.LambdaFunction(this.service, { event: events.RuleTargetInput.fromObject({ type: 'scheduled-check' }) })],
    });

    // --- Shared: alarms and their metrics -------------------------------------------------
    this.service.addToRolePolicy(new iam.PolicyStatement({
      // paired API alarms, Lambda manager's registered alarms
      actions: ['cloudwatch:DescribeAlarms'],
      resources: [arn('cloudwatch', 'alarm', `${PROJECT_NAME}-*`)],
    }));
    this.service.addToRolePolicy(new iam.PolicyStatement({
      // GetMetricData has no resource-level permissions
      actions: ['cloudwatch:GetMetricData'],
      resources: ['*'],
    }));
    // Each manager reads its target from the project stack's RollbackTarget output.
    this.service.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [ALARM_TYPES.apigateway.stack(env), ALARM_TYPES.cloudfront.stack(env)]
        .map((stackName) => this.formatArn({ service: 'cloudformation', resource: 'stack', resourceName: `${stackName}/*` })),
    }));

    // --- API Gateway manager ------------------------------------------------------------
    // The REST API id is only known once the API is deployed (it's read from the stack output),
    // so this allows the REST APIs of this account and region.
    this.service.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET', 'apigateway:PUT', 'apigateway:POST'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}::/restapis/*`,
      ],
    }));
    // The API's backend Lambdas, one per resource: rollback-factory-demo-api-<resource>-<env>
    const apiBackends = arn('lambda', 'function', name('api-*'));
    this.service.addToRolePolicy(new iam.PolicyStatement({
      // GetAlias: record the versions the live aliases serve. No AddPermission: a restored spec only
      // invokes the stage aliases, whose permissions the API stack manages.
      actions: ['lambda:GetAlias'],
      resources: [apiBackends, `${apiBackends}:*`],
    }));
    s3.Bucket.fromBucketName(this, 'ApiSpecBucket', name(`${cdk.Aws.ACCOUNT_ID}-deployments`)).grantReadWrite(this.service);
    dynamodb.TableV2.fromTableName(this, 'ApiDeploymentsTable', name('deployments')).grantReadWriteData(this.service);

    // --- CloudFront manager ---------------------------------------------------------------
    this.service.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution', 'cloudfront:CreateInvalidation'],
      resources: [this.formatArn({ service: 'cloudfront', region: '', resource: 'distribution', resourceName: '*' })],
    }));
    dynamodb.TableV2.fromTableName(this, 'FrontendDeploymentsTable', name('frontend-deployments')).grantReadWriteData(this.service);

    // --- Lambda manager ---------------------------------------------------------------------
    // The service's own role has no Lambda, S3 or DynamoDB permissions for the registered functions.
    // It assumes this role with a session policy scoped to a single function (managers/lambda/scoped.ts).
    // This role is the upper bound: registered functions only.
    const registered = [...resolveRegistry(rollbackConfig, env).values()];
    // No fixed name: deploy-aws-lambda's stacks created rollback-factory-demo-lambda-rollback-execution-<env>
    // before the rollback service existed, and a fixed name would collide with it.
    const lambdaRole = new iam.Role(this, 'LambdaRollbackRole', {
      assumedBy: this.service.role!,
      maxSessionDuration: cdk.Duration.hours(1),
    });
    const registeredArns = registered.map(({ name: fn }) => arn('lambda', 'function', fn));
    if (registeredArns.length > 0) {
      lambdaRole.addToPolicy(new iam.PolicyStatement({
        actions: ['lambda:GetAlias', 'lambda:ListVersionsByFunction', 'lambda:UpdateAlias', 'lambda:GetFunction', 'lambda:UpdateFunctionCode'],
        resources: registeredArns.flatMap((fnArn) => [fnArn, `${fnArn}:*`]),
      }));
      lambdaRole.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: registered.map(({ name: fn }) => artifactsBucket.arnForObjects(`${fn}/*`)),
      }));
      lambdaRole.addToPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
        resources: [versionsTable.tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': registered.map(({ name: fn }) => fn) } },
      }));
    }
    lambdaRole.grantAssumeRole(this.service.role!);
    this.service.addEnvironment('LAMBDA_ROLLBACK_ROLE_ARN', lambdaRole.roleArn);

    // --- Outputs --------------------------------------------------------------------------
    const out = (outputName: string, value: string) =>
      new cdk.CfnOutput(this, outputName, { value, exportName: name(`rollback-service-${outputName}`) });
    out('FunctionName', this.service.functionName);
    out('VersionsTableName', versionsTable.tableName);
    out('ArtifactsBucketName', artifactsBucket.bucketName);
  }
}
