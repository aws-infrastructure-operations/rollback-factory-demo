import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
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

  constructor(scope: Construct, id: string, props: ApiUserStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removalPolicy = config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // --- Auth -----------------------------------------------------------------
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${config.apiName}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: { minLength: 12, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy,
    });

    this.userPoolClient = this.userPool.addClient('ApiClient', {
      userPoolClientName: `${config.apiName}-client`,
      generateSecret: false,
      // USER_PASSWORD_AUTH lets scripts / CI fetch tokens without a browser flow.
      authFlows: { userPassword: true, userSrp: true },
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      authorizerName: `${config.apiName}-cognito`,
      cognitoUserPools: [this.userPool],
      identitySource: apigw.IdentitySource.header('Authorization'),
    });

    // --- Backend --------------------------------------------------------------
    const handler = new NodejsFunction(this, 'ApiHandler', {
      functionName: `${config.apiName}-handler`,
      entry: path.join(__dirname, '..', 'lambda', 'api', 'handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: { API_NAME: config.apiName },
      logGroup: new logs.LogGroup(this, 'ApiHandlerLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true },
    });

    // --- API ------------------------------------------------------------------
    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: config.apiName,
      description: `User API (${config.envName})`,
      endpointTypes: [apigw.EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: {
        stageName: config.stageName,
        metricsEnabled: true,
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
      },
      defaultMethodOptions: {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
      },
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

    const integration = new apigw.LambdaIntegration(handler);
    for (const resourceName of ['users', 'messages']) {
      const resource = this.api.root.addResource(resourceName);
      resource.addMethod('GET', integration);
      resource.addMethod('POST', integration, {
        requestValidator: bodyValidator,
        requestModels: { 'application/json': messageModel },
      });
    }

    // --- Outputs --------------------------------------------------------------
    const out = (name: string, value: string) =>
      new cdk.CfnOutput(this, name, { value, exportName: `${config.apiName}-${name}` });
    out('ApiId', this.api.restApiId);
    out('ApiUrl', this.api.url);
    out('StageName', config.stageName);
    out('UserPoolId', this.userPool.userPoolId);
    out('UserPoolClientId', this.userPoolClient.userPoolClientId);
  }
}
