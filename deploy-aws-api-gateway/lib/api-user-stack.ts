import { execSync } from 'node:child_process';
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
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { Backend, BACKENDS, EnvConfig } from './config.js';

/** One backend Lambda with the aliases the stages invoke. */
interface BackendResources {
  fn: NodejsFunction;
  live: lambda.Alias;
  integration: lambda.Alias;
}

const BACKEND_DIR = path.join(__dirname, '..', 'lambda', 'api');

/**
 * Describes a published backend version: the deploy that published it, and the last commit that
 * touched the backends' code (like deploy-aws-lambda's), e.g. "deploy 123.1 · 4f46d40 Split ...".
 */
export function versionDescription(deployId?: string, dir = BACKEND_DIR): string {
  let commit: string;
  try {
    commit = execSync(`git log -1 --format="%h %s" -- "${dir}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'uncommitted';
  } catch {
    commit = 'unknown (no git)';
  }
  return (deployId ? `deploy ${deployId} · ${commit}` : commit).slice(0, 256);
}

export interface ApiUserStackProps extends cdk.StackProps {
  config: EnvConfig;
}

export class ApiUserStack extends cdk.Stack {
  readonly api: apigw.RestApi;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly specBucket: s3.Bucket;
  readonly deploymentsTable: dynamodb.TableV2;
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
    // One Lambda per resource (/users, /messages, /orders), so each can be rolled back on its own: all are
    // registered in rollback-service/rollback-config.json with their errors alarm (below).
    // Each stage invokes its own alias of them, named by its `lambdaAlias` stage variable:
    // - `integration` moves to the newly published version on every `cdk deploy`
    // - `live` (stage v1) stays where it is when CI passes config.live; scripts/promote-deployment.ts
    //   moves it once the integration tests passed, and the rollback service moves it back on its
    //   errors alarm. Without config.live it moves on deploy too.
    // An API rollback re-imports an old spec but keeps the aliases, so it never rolls the code back
    // (see pointToAlias in rollback-service/lambda/managers/apigateway/plan.ts).
    const backends = Object.fromEntries(BACKENDS.map((backend) => [backend, this.backend(config, backend)])) as Record<Backend, BackendResources>;

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
      // Stage v1 may still serve an older deployment while the integration stage tests the
      // new one, so CloudFormation must not delete replaced deployments.
      retainDeployments: true,
      deployOptions: {
        stageName: config.stageName,
        variables: { lambdaAlias: 'live' },
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

    // Each resource integrates with its own function's stage alias (stage variable lambdaAlias), so
    // v1 runs the promoted code and the integration stage the code under test - also after an API rollback.
    for (const backend of BACKENDS) {
      const { fn, live, integration: integrationAlias } = backends[backend];
      const integration = new apigw.Integration({
        type: apigw.IntegrationType.AWS_PROXY,
        integrationHttpMethod: 'POST',
        uri: `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}:lambda:path/2015-03-31/functions/`
          // DEMO BRANCH (demo/break-api-gateway) - DO NOT MERGE.
          // A bad API config change: the integrations read a new stage variable, backendAlias, that only
          // the integration stage defines. The integration tests pass there, CI promotes the deployment
          // to v1, and on v1 every route resolves to "<function>:" (no alias): API Gateway answers 500
          // without invoking the Lambda. The 5xx alarm fires and, as the Lambda isn't at fault, the
          // rollback service restores the previous verified deployment's spec.
          + `${fn.functionArn}:\${stageVariables.backendAlias}/invocations`,
      });
      const resource = this.api.root.addResource(backend);
      resource.addMethod('GET', integration);
      resource.addMethod('POST', integration, {
        requestValidator: bodyValidator,
        requestModels: { 'application/json': messageModel },
      });
      for (const alias of [live, integrationAlias]) {
        alias.addPermission('ApiGatewayInvoke', {
          principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
          // <api>/<stage>/<method>/<backend>: any stage and method, this resource only
          sourceArn: this.api.arnForExecuteApi('*', `/${backend}`, '*'),
        });
      }
    }

    // CI keeps stage v1 on the deployment it serves and deploys to the integration stage;
    // scripts/promote-deployment.ts moves v1 once the integration tests passed.
    if (config.live?.deploymentId) {
      (this.api.deploymentStage.node.defaultChild as apigw.CfnStage).deploymentId = config.live.deploymentId;
    }
    // No access logs / detailed metrics: test traffic must not count toward v1's alarms
    // (the API metrics are per stage anyway).
    const integrationStage = new apigw.Stage(this, 'IntegrationStage', {
      deployment: this.api.latestDeployment!,
      stageName: config.integrationStageName,
      variables: { lambdaAlias: 'integration', backendAlias: 'integration' },
      throttlingRateLimit: 10,
      throttlingBurstLimit: 20,
    });

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

    // --- Alarms ------------------------------------------------------------------
    // They publish to the rollback service's topic (rollback-service, deployed first), whose one
    // Lambda routes rollback-factory-demo-apigateway-* alarms to its API Gateway manager.
    const rollbackTopic = sns.Topic.fromTopicArn(this, 'RollbackTopic',
      this.formatArn({ service: 'sns', resource: config.rollbackTopicName }));

    const apiMetric = (metricName: string) => new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName,
      dimensionsMap: { ApiName: config.apiName, Stage: config.stageName },
      statistic: cloudwatch.Stats.SUM,
      period: cdk.Duration.minutes(1),
    });
    const { alarms: a } = config;
    const errorClasses = [
      { kind: '4xx', metricName: '4XXError', key: 'error4xx', threshold: a.error4xxRatePercent, minRequests: a.minRequests4xx },
      { kind: '5xx', metricName: '5XXError', key: 'error5xx', threshold: a.error5xxRatePercent, minRequests: a.minRequests5xx },
    ] as const;

    // API alarms: every 4xx / 5xx the clients received, whoever produced it. They trigger the rollback.
    const alarms = errorClasses.map((c) => this.errorRateAlarm(`Alarm${c.kind}`, config, {
      ...c,
      alarmName: config.alarmNames[c.key],
      description: `More than ${c.threshold}% ${c.kind} responses (min ${c.minRequests} requests/min) on `
        + `${config.apiName}/${config.stageName}. Triggers the rollback service via SNS.`,
      errors: apiMetric(c.metricName),
      requests: apiMetric('Count'),
    }));
    for (const alarm of alarms) alarm.addAlarmAction(new cwActions.SnsAction(rollbackTopic));

    // Paired Lambda alarms: the same rates, counting only the errors of requests that reached
    // a backend Lambda (the access log has a lambdaRequestId) - errors it returned, threw or
    // timed out on. Errors API Gateway produced on its own (authorizer, validator, unknown route,
    // throttling, invoke permissions) are left out. While the paired Lambda alarm is in ALARM the
    // rollback service skips the API rollback: the API always invokes the latest Lambdas, so
    // re-importing an old spec would not fix the code (each Lambda's own errors alarm is for that).
    const lambdaAlarms = errorClasses.map((c) => {
      const metricName = `Lambda${c.metricName}`;
      new logs.MetricFilter(this, `LambdaErrorsFilter${c.kind}`, {
        logGroup: this.accessLogGroup,
        filterName: name(`lambda-${c.kind}`),
        filterPattern: logs.FilterPattern.all(
          logs.FilterPattern.stringValue('$.status', '=', `${c.kind[0]}*`),
          logs.FilterPattern.stringValue('$.lambdaRequestId', '!=', '-'),
        ),
        metricNamespace: config.metricsNamespace,
        metricName,
        metricValue: '1',
        defaultValue: 0,
      });
      return this.errorRateAlarm(`AlarmLambda${c.kind}`, config, {
        ...c,
        alarmName: config.lambdaAlarmNames[c.key],
        description: `More than ${c.threshold}% ${c.kind} responses produced by the backend Lambdas `
          + `(min ${c.minRequests} requests/min) on ${config.apiName}/${config.stageName}. `
          + `While in ALARM, ${config.alarmNames[c.key]} does not roll the API back.`,
        errors: new cloudwatch.Metric({
          namespace: config.metricsNamespace,
          metricName,
          statistic: cloudwatch.Stats.SUM,
          period: cdk.Duration.minutes(1),
        }),
        requests: apiMetric('Count'),
      });
    });
    for (const alarm of lambdaAlarms) alarm.addAlarmAction(new cwActions.SnsAction(rollbackTopic));

    // Each backend's errors alarm: unhandled errors on its live alias, unqualified calls or $LATEST
    // (never integration). Named rollback-factory-demo-lambda-api-<resource>-errors-<env>: the rollback
    // service's Lambda manager moves that function's live alias back (rollback-config.json).
    const errorsAlarms = BACKENDS.map((backend) => {
      const alarm = this.errorsAlarm(config, backend);
      alarm.addAlarmAction(new cwActions.SnsAction(rollbackTopic));
      return alarm;
    });

    // --- Outputs --------------------------------------------------------------
    const out = (name: string, value: string) =>
      new cdk.CfnOutput(this, name, { value, exportName: config.resourceName(name) });
    out('ApiId', this.api.restApiId);
    out('ApiUrl', this.api.url);
    out('IntegrationStageName', integrationStage.stageName);
    out('IntegrationApiUrl', integrationStage.urlForPath());
    out('StageName', config.stageName);
    out('UserPoolId', this.userPool.userPoolId);
    out('UserPoolClientId', this.userPoolClient.userPoolClientId);
    out('SpecBucketName', this.specBucket.bucketName);
    out('DeploymentsTableName', this.deploymentsTable.tableName);
    out('Alarm4xxName', alarms[0].alarmName);
    out('Alarm5xxName', alarms[1].alarmName);
    BACKENDS.forEach((backend, i) => {
      const key = `${backend[0].toUpperCase()}${backend.slice(1)}`;
      out(`${key}FunctionName`, backends[backend].fn.functionName);
      out(`${key}ErrorsAlarmName`, errorsAlarms[i].alarmName);
    });
    out('LambdaAlarm4xxName', lambdaAlarms[0].alarmName);
    out('LambdaAlarm5xxName', lambdaAlarms[1].alarmName);
    out('AccessLogGroupName', this.accessLogGroup.logGroupName);
    // What the rollback service's API Gateway manager needs, as one JSON output it reads at runtime
    // (rollback-service/lambda/managers/apigateway/manager.ts: ApiRollbackTarget). Not exported: the
    // service reads it with DescribeStacks, and an export value may only be 1024 characters long,
    // which the backends' ARNs exceed.
    new cdk.CfnOutput(this, 'RollbackTarget', { value: cdk.Stack.of(this).toJsonString({
      apiName: config.apiName,
      restApiId: this.api.restApiId,
      stageName: config.stageName,
      specBucket: this.specBucket.bucketName,
      table: this.deploymentsTable.tableName,
      // every backend: an API rollback keeps their integrations on the stage's alias
      backendFunctionArns: BACKENDS.map((backend) => backends[backend].fn.functionArn),
      alarmNames: Object.values(config.alarmNames),
      // API alarm -> its paired Lambda alarm and the metrics the manager compares
      alarmPairs: errorClasses.map((c) => ({
        apiAlarm: config.alarmNames[c.key],
        lambdaAlarm: config.lambdaAlarmNames[c.key],
        apiMetric: c.metricName,
        lambdaMetric: `Lambda${c.metricName}`,
      })),
      metricsNamespace: config.metricsNamespace,
      rollbackWindowMinutes: config.rollbackWindowMinutes,
      evaluationMinutes: config.alarms.evaluationPeriods,
    }) });
  }

  /** The Lambda serving /<backend>, with its integration alias and its live alias (pinned by config.live). */
  private backend(config: EnvConfig, backend: Backend): BackendResources {
    const id = `${backend[0].toUpperCase()}${backend.slice(1)}`;
    const fn = new NodejsFunction(this, `${id}Handler`, {
      functionName: config.backends[backend].functionName,
      description: `/${backend} of ${config.apiName}; rolled back on its own by the rollback service`,
      entry: path.join(__dirname, '..', 'lambda', 'api', `${backend}.ts`),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        API_NAME: config.apiName,
        CHAOS_FAILURE_RATE: String(config.chaosFailureRate),
        // a new value on every deploy changes the configuration, so a new version is published
        ...(config.deployId && { DEPLOY_ID: config.deployId }),
      },
      logGroup: new logs.LogGroup(this, `${id}HandlerLogs`, {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true },
      // Keep every published version: the rollback service rolls live back to older ones.
      currentVersionOptions: {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        description: versionDescription(config.deployId),
      },
    });
    const liveVersion = config.live?.lambdaVersions[backend];
    return {
      fn,
      integration: new lambda.Alias(this, `${id}Integration`, { aliasName: 'integration', version: fn.currentVersion }),
      live: new lambda.Alias(this, `${id}Live`, {
        aliasName: 'live',
        version: liveVersion
          ? lambda.Version.fromVersionAttributes(this, `${id}LiveVersion`, { lambda: fn, version: liveVersion })
          : fn.currentVersion,
      }),
    };
  }

  /**
   * Errors (unhandled errors and timeouts) of a backend on its live alias, unqualified calls and
   * $LATEST, never the integration alias: >= 1 in a minute. Like deploy-aws-lambda's alarm, so the
   * rollback service's Lambda manager finds the function from the FunctionName dimension.
   */
  private errorsAlarm(config: EnvConfig, backend: Backend): cloudwatch.Alarm {
    const id = `${backend[0].toUpperCase()}${backend.slice(1)}`;
    const functionName = config.backends[backend].functionName;
    const errorsFor = (resource: string) => new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      dimensionsMap: { FunctionName: functionName, Resource: resource },
      statistic: cloudwatch.Stats.SUM,
      period: cdk.Duration.minutes(1),
    });
    return new cloudwatch.Alarm(this, `Alarm${id}Errors`, {
      alarmName: config.backends[backend].errorsAlarmName,
      alarmDescription: `Errors on ${functionName}:live or $LATEST; the rollback service rolls ${functionName}:live back`,
      metric: new cloudwatch.MathExpression({
        expression: 'FILL(live, 0) + FILL(unqualified, 0) + FILL(latest, 0)',
        usingMetrics: {
          live: errorsFor(`${functionName}:live`),
          unqualified: errorsFor(functionName),
          latest: errorsFor(`${functionName}:$LATEST`),
        },
        label: `${functionName} errors (live + $LATEST)`,
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled: config.alarms.notificationsEnabled,
    });
  }

  /**
   * Alarms on the share of requests in a minute that were `errors`,
   * ignoring minutes with fewer than `minRequests` requests.
   */
  private errorRateAlarm(id: string, config: EnvConfig, opts: {
    alarmName: string;
    description: string;
    kind: string;
    errors: cloudwatch.IMetric;
    requests: cloudwatch.IMetric;
    threshold: number;
    minRequests: number;
  }): cloudwatch.Alarm {
    return new cloudwatch.Alarm(this, id, {
      alarmName: opts.alarmName,
      alarmDescription: opts.description,
      metric: new cloudwatch.MathExpression({
        expression: `IF(requests >= ${opts.minRequests}, 100 * errors / requests, 0)`,
        usingMetrics: { requests: opts.requests, errors: opts.errors },
        label: `${opts.kind} rate %`,
        period: cdk.Duration.minutes(1),
      }),
      threshold: opts.threshold,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: config.alarms.evaluationPeriods,
      datapointsToAlarm: config.alarms.datapointsToAlarm,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled: config.alarms.notificationsEnabled,
    });
  }
}
