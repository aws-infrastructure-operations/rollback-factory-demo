import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { EnvConfig } from './config.js';

export interface ApiUserStackProps extends cdk.StackProps {
  config: EnvConfig;
}

export class ApiUserStack extends cdk.Stack {
  readonly api: apigw.RestApi;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly specBucket: s3.Bucket;
  readonly deploymentsTable: dynamodb.TableV2;
  readonly alarmTopic: sns.Topic;
  readonly rollbackFunction: NodejsFunction;
  readonly accessLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ApiUserStackProps) {
    super(scope, id, props);
    const { config } = props;
    const name = config.resourceName;
    const removalPolicy = config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // --- Auth -----------------------------------------------------------------
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: name('users'),
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: { minLength: 12, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy,
    });

    this.userPoolClient = this.userPool.addClient('ApiClient', {
      userPoolClientName: name('client'),
      generateSecret: false,
      // USER_PASSWORD_AUTH lets scripts / CI fetch tokens without a browser flow.
      authFlows: { userPassword: true, userSrp: true },
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      authorizerName: name('cognito'),
      cognitoUserPools: [this.userPool],
      identitySource: apigw.IdentitySource.header('Authorization'),
    });

    // --- Backend --------------------------------------------------------------
    const handler = new NodejsFunction(this, 'ApiHandler', {
      functionName: name('handler'),
      entry: path.join(__dirname, '..', 'lambda', 'api', 'handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        API_NAME: config.apiName,
        CHAOS_FAILURE_RATE: String(config.chaosFailureRate),
      },
      logGroup: new logs.LogGroup(this, 'ApiHandlerLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true },
      // Keep every published version: old specs in S3 reference them, and rollbacks need them.
      currentVersionOptions: { removalPolicy: cdk.RemovalPolicy.RETAIN },
    });

    // --- Access logs ----------------------------------------------------------
    // One JSON line per request. errorType / integration* tell API Gateway failures
    // apart from Lambda failures (README: "Troubleshooting 5xx: API Gateway or Lambda?").
    this.accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: name('api-access-logs'),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });
    const F = apigw.AccessLogField;
    const accessLogFormat = apigw.AccessLogFormat.custom(JSON.stringify({
      requestId: F.contextRequestId(),
      time: F.contextRequestTime(),
      method: F.contextHttpMethod(),
      resourcePath: F.contextResourcePath(),
      status: F.contextStatus(),
      responseLatency: F.contextResponseLatency(),
      // set when API Gateway itself produced the error, e.g. INTEGRATION_FAILURE,
      // INTEGRATION_TIMEOUT, AUTHORIZER_FAILURE, UNAUTHORIZED, BAD_REQUEST_BODY, THROTTLED
      errorType: F.contextErrorResponseType(),
      errorMessage: F.contextErrorMessage(),
      authorizerError: F.contextAuthorizerError(),
      // what the Lambda integration returned; lambdaRequestId matches "RequestId:" in the Lambda logs
      integrationStatus: '$context.integration.status', // status code returned by the function code
      lambdaServiceStatus: F.contextIntegrationStatus(), // status of the call to the Lambda service itself
      integrationError: '$context.integration.error',
      integrationErrorMessage: F.contextIntegrationErrorMessage(),
      integrationLatency: F.contextIntegrationLatency(),
      lambdaRequestId: '$context.integration.requestId',
      sourceIp: F.contextIdentitySourceIp(),
    }));

    // --- API ------------------------------------------------------------------
    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: config.apiName,
      description: `User API (${config.envName})`,
      endpointTypes: [apigw.EndpointType.REGIONAL],
      // Access logging needs API Gateway's account-level CloudWatch role. It is one setting
      // per account and region, shared by all APIs, so keep it if this stack is deleted.
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: cdk.RemovalPolicy.RETAIN,
      deployOptions: {
        stageName: config.stageName,
        metricsEnabled: true,
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
        accessLogDestination: new apigw.LogGroupLogDestination(this.accessLogGroup),
        accessLogFormat,
      },
      defaultMethodOptions: {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
      },
      // The frontend calls the API from its CloudFront domain. Any origin is fine:
      // the token is sent in the Authorization header, never as a cookie.
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // Errors produced by API Gateway itself (401 from the authorizer, 400 from the
    // validator, 5xx) need CORS headers too, or the browser hides them from the app.
    for (const [id, type] of [['Cors4xx', apigw.ResponseType.DEFAULT_4XX], ['Cors5xx', apigw.ResponseType.DEFAULT_5XX]] as const) {
      this.api.addGatewayResponse(id, {
        type,
        responseHeaders: { 'Access-Control-Allow-Origin': "'*'" },
      });
    }

    // Saved Logs Insights queries (CloudWatch -> Logs Insights -> Saved queries)
    new logs.QueryDefinition(this, 'Query5xxByCause', {
      queryDefinitionName: name('api-5xx-by-cause'),
      logGroups: [this.accessLogGroup],
      queryString: new logs.QueryString({
        filterStatements: ['status like /^5/'],
        statsStatements: ['count(*) as requests by errorType, integrationStatus, integrationErrorMessage'],
        sort: 'requests desc',
      }),
    });
    new logs.QueryDefinition(this, 'Query5xxRequests', {
      queryDefinitionName: name('api-5xx-requests'),
      logGroups: [this.accessLogGroup],
      queryString: new logs.QueryString({
        fields: [
          '@timestamp', 'method', 'resourcePath', 'status', 'errorType',
          'integrationStatus', 'integrationErrorMessage', 'lambdaRequestId',
        ],
        filterStatements: ['status like /^5/'],
        sort: '@timestamp desc',
        limit: 100,
      }),
    });

    const messageModel = this.api.addModel('MessageModel', {
      modelName: 'Message',
      contentType: 'application/json',
      schema: {
        schema: apigw.JsonSchemaVersion.DRAFT4,
        type: apigw.JsonSchemaType.OBJECT,
        required: ['message'],
        properties: {
          message: { type: apigw.JsonSchemaType.STRING, minLength: 1, maxLength: 500 },
        },
      },
    });
    const bodyValidator = this.api.addRequestValidator('BodyValidator', {
      requestValidatorName: 'validate-body',
      validateRequestBody: true,
    });

    // Integrate with a published version, not $LATEST: each deployment's exported spec
    // then pins the code it ran with, so re-importing an old spec also rolls back the code.
    // Old versions are retained (currentVersionOptions above) so rollbacks can still invoke them.
    const integration = new apigw.LambdaIntegration(handler.currentVersion);
    for (const resourceName of ['users', 'messages']) {
      const resource = this.api.root.addResource(resourceName);
      resource.addMethod('GET', integration);
      resource.addMethod('POST', integration, {
        requestValidator: bodyValidator,
        requestModels: { 'application/json': messageModel },
      });
    }

    // --- Deployment tracking ----------------------------------------------------
    // One OpenAPI export per deployment, stored under <apiName>/<timestamp>/ (see lambda/shared/deployments.ts).
    this.specBucket = new s3.Bucket(this, 'SpecBucket', {
      bucketName: name(`${cdk.Aws.ACCOUNT_ID}-deployments`),
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !config.retainData,
    });

    // One item per deployment: pk = apiName, sk = deployedAt (ISO 8601), newest first via ScanIndexForward=false.
    this.deploymentsTable = new dynamodb.TableV2(this, 'DeploymentsTable', {
      tableName: name('deployments'),
      partitionKey: { name: 'apiName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'deployedAt', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config.retainData },
      removalPolicy,
    });

    // --- Alarms & rollback ------------------------------------------------------
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: name('notifications'),
      displayName: `${config.apiName} alarms`,
      enforceSSL: true,
    });
    if (config.alarms.email) {
      this.alarmTopic.addSubscription(new snsSubs.EmailSubscription(config.alarms.email));
    }

    const alarms = [
      this.errorRateAlarm('4XXError', config, config.alarms.error4xxRatePercent, config.alarms.minRequests4xx),
      this.errorRateAlarm('5XXError', config, config.alarms.error5xxRatePercent, config.alarms.minRequests5xx),
    ];
    for (const alarm of alarms) alarm.addAlarmAction(new cwActions.SnsAction(this.alarmTopic));

    // Informational: unhandled errors thrown by the backend Lambda (all versions).
    // Comparing it with the 5xx alarm tells code failures apart from API Gateway
    // failures. It notifies the topic (e.g. e-mail) but never triggers a rollback:
    // the rollback Lambda's subscription only accepts config.alarmNames.
    const lambdaErrorsAlarm = new cloudwatch.Alarm(this, 'AlarmLambdaErrors', {
      alarmName: name('lambda-errors'),
      alarmDescription:
        `${handler.functionName} threw unhandled errors (Lambda Errors > 0 in 2 of 3 minutes). `
        + 'Informational - does not trigger a rollback.',
      metric: handler.metricErrors({ period: cdk.Duration.minutes(1), statistic: cloudwatch.Stats.SUM }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: config.alarms.evaluationPeriods,
      datapointsToAlarm: config.alarms.datapointsToAlarm,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled: config.alarms.notificationsEnabled,
    });
    lambdaErrorsAlarm.addAlarmAction(new cwActions.SnsAction(this.alarmTopic));

    // enforceSSL gives the topic its own resource policy, which replaces the default
    // one that let the account publish - so CloudWatch must be allowed explicitly
    // (only for this API's alarms in this account, to avoid confused-deputy access).
    this.alarmTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarms',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [this.alarmTopic.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
        ArnLike: { 'aws:SourceArn': [...alarms, lambdaErrorsAlarm].map((a) => a.alarmArn) },
      },
    }));

    this.rollbackFunction = new NodejsFunction(this, 'RollbackFunction', {
      functionName: name('rollback'),
      description: `Rolls ${config.apiName}/${config.stageName} back to the previous deployment's spec on alarm`,
      entry: path.join(__dirname, '..', 'lambda', 'rollback', 'handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      retryAttempts: 0,
      environment: {
        API_NAME: config.apiName,
        REST_API_ID: this.api.restApiId,
        STAGE_NAME: config.stageName,
        SPEC_BUCKET: this.specBucket.bucketName,
        DEPLOYMENTS_TABLE: this.deploymentsTable.tableName,
        ROLLBACK_WINDOW_MINUTES: String(config.rollbackWindowMinutes),
        ALARM_NAMES: Object.values(config.alarmNames).join(','),
      },
      logGroup: new logs.LogGroup(this, 'RollbackLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true },
    });
    // Only this API's alarms trigger a rollback, even if something else publishes to the topic.
    this.alarmTopic.addSubscription(new snsSubs.LambdaSubscription(this.rollbackFunction, {
      filterPolicyWithMessageBody: {
        AlarmName: sns.FilterOrPolicy.filter(sns.SubscriptionFilter.stringFilter({
          allowlist: Object.values(config.alarmNames),
        })),
      },
    }));

    this.specBucket.grantReadWrite(this.rollbackFunction);
    this.deploymentsTable.grantReadWriteData(this.rollbackFunction);
    this.rollbackFunction.addToRolePolicy(new iam.PolicyStatement({
      // GetStage/GetExport, PutRestApi, CreateDeployment on this API only
      actions: ['apigateway:GET', 'apigateway:PUT', 'apigateway:POST'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}::/restapis/${this.api.restApiId}`,
        `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}::/restapis/${this.api.restApiId}/*`,
      ],
    }));
    this.rollbackFunction.addToRolePolicy(new iam.PolicyStatement({
      // re-grant API Gateway access to the Lambda version referenced by an old spec
      actions: ['lambda:AddPermission'],
      resources: [handler.functionArn, `${handler.functionArn}:*`],
    }));

    // --- Outputs --------------------------------------------------------------
    const out = (name: string, value: string) =>
      new cdk.CfnOutput(this, name, { value, exportName: config.resourceName(name) });
    out('ApiId', this.api.restApiId);
    out('ApiUrl', this.api.url);
    out('StageName', config.stageName);
    out('UserPoolId', this.userPool.userPoolId);
    out('UserPoolClientId', this.userPoolClient.userPoolClientId);
    out('SpecBucketName', this.specBucket.bucketName);
    out('DeploymentsTableName', this.deploymentsTable.tableName);
    out('AlarmTopicArn', this.alarmTopic.topicArn);
    out('Alarm4xxName', alarms[0].alarmName);
    out('Alarm5xxName', alarms[1].alarmName);
    out('RollbackFunctionName', this.rollbackFunction.functionName);
    out('LambdaErrorsAlarmName', lambdaErrorsAlarm.alarmName);
    out('AccessLogGroupName', this.accessLogGroup.logGroupName);
  }

  /**
   * Alarms on the share of requests in a minute that returned `metricName`,
   * ignoring minutes with fewer than `minRequests` requests.
   */
  private errorRateAlarm(
    metricName: '4XXError' | '5XXError',
    config: EnvConfig,
    thresholdPercent: number,
    minRequests: number,
  ): cloudwatch.Alarm {
    const metric = (name: string) => new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: name,
      dimensionsMap: { ApiName: config.apiName, Stage: config.stageName },
      statistic: cloudwatch.Stats.SUM,
      period: cdk.Duration.minutes(1),
    });
    const kind = metricName.slice(0, 3).toLowerCase();

    return new cloudwatch.Alarm(this, `Alarm${kind}`, {
      alarmName: metricName === '4XXError' ? config.alarmNames.error4xx : config.alarmNames.error5xx,
      alarmDescription:
        `More than ${thresholdPercent}% ${kind} responses (min ${minRequests} requests/min) on `
        + `${config.apiName}/${config.stageName}. Triggers the rollback Lambda via SNS.`,
      metric: new cloudwatch.MathExpression({
        expression: `IF(requests >= ${minRequests}, 100 * errors / requests, 0)`,
        usingMetrics: { requests: metric('Count'), errors: metric(metricName) },
        label: `${kind} rate %`,
        period: cdk.Duration.minutes(1),
      }),
      threshold: thresholdPercent,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: config.alarms.evaluationPeriods,
      datapointsToAlarm: config.alarms.datapointsToAlarm,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled: config.alarms.notificationsEnabled,
    });
  }
}
