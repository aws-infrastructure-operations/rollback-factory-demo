import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
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
import { resolveRegistry } from '../lambda/rollback/registry.js';
import { EnvConfig, INTEGRATION_ALIAS, LIVE_ALIAS, ROLLBACK_SETTINGS } from './config.js';

const SERVICE_DIR = path.join(__dirname, '..', 'lambda', 'service');

/**
 * Describes the code a published version contains: the last commit that touched the service's code.
 * It only changes when that code changes, so it never forces a new version on its own.
 */
export function versionDescription(dir = SERVICE_DIR): string {
  try {
    const commit = execSync(`git log -1 --format="%h %s" -- "${dir}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return commit ? commit.slice(0, 256) : 'uncommitted';
  } catch {
    return 'unknown (no git)';
  }
}

export interface LambdaServiceStackProps extends cdk.StackProps {
  config: EnvConfig;
  /** Defaults to versionDescription(); tests pass a fixed one. */
  versionDescription?: string;
}

/**
 * service-lambda-<env> with its `integration` and `live` aliases, and the rollback system around it:
 * errors alarm -> SNS -> rollback function, which archives every version (S3 + DynamoDB) and moves
 * `live` back to the previous version that was live.
 */
export class LambdaServiceStack extends cdk.Stack {
  readonly service: NodejsFunction;
  readonly rollbackFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: LambdaServiceStackProps) {
    super(scope, id, props);
    const { config } = props;
    const name = config.resourceName;
    const removalPolicy = config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const registered = [...resolveRegistry(rollbackConfig, config.envName).values()];

    // --- Service --------------------------------------------------------------
    this.service = new NodejsFunction(this, 'ServiceFunction', {
      functionName: config.functionName,
      description: `${config.functionName}: demo service with integration-first deploys and automatic rollback`,
      entry: path.join(SERVICE_DIR, 'handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      logGroup: new logs.LogGroup(this, 'ServiceLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true },
      // Keep old versions when a new one is published, so rollback has something to point at.
      currentVersionOptions: {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        description: props.versionDescription ?? versionDescription(),
      },
    });

    // Every deploy that changes the code or configuration publishes a new immutable version.
    // `integration` always moves to it: CI runs the integration tests there first.
    new lambda.Alias(this, 'IntegrationAlias', { aliasName: INTEGRATION_ALIAS, version: this.service.currentVersion });
    // `live` (what clients call) stays where it is when CI passes -c liveLambdaVersion;
    // scripts/promote.ts moves it once the tests passed. Without it (first deploy) it takes the new version.
    const liveAlias = new lambda.Alias(this, 'LiveAlias', {
      aliasName: LIVE_ALIAS,
      version: config.liveLambdaVersion
        ? lambda.Version.fromVersionAttributes(this, 'LiveVersion', { lambda: this.service, version: config.liveLambdaVersion })
        : this.service.currentVersion,
    });

    // --- Version archive --------------------------------------------------------
    // Metadata of every published version of every registered function, plus a CURRENT item per
    // function (version the alias points to, who set it, rollback count).
    //   functionName = <fn>, sk = VERSION#0000000003 | CURRENT
    const versionsTable = new dynamodb.TableV2(this, 'VersionsTable', {
      tableName: config.versionsTableName,
      partitionKey: { name: 'functionName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config.retainData },
      removalPolicy,
    });

    // Package of every archived version, as <fn>/<fn>-<version>.zip. Rollbacks restore $LATEST from here.
    const artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: name(`${cdk.Aws.ACCOUNT_ID}-lambda-artifacts`),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !config.retainData,
    });

    // --- Rollback function --------------------------------------------------------
    const rollbackTopic = new sns.Topic(this, 'RollbackTopic', {
      topicName: config.rollbackTopicName,
      displayName: `${config.functionName} rollback`,
      enforceSSL: true,
    });

    this.rollbackFunction = new NodejsFunction(this, 'RollbackFunction', {
      functionName: config.rollbackFunctionName,
      description: `Archives versions of registered functions and rolls their alias back on alarm (${config.envName})`,
      entry: path.join(__dirname, '..', 'lambda', 'rollback', 'handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      // Archiving packages to S3, restoring $LATEST and waiting for the update to finish.
      timeout: cdk.Duration.minutes(2),
      // Packages are held in memory while being copied to S3.
      memorySize: 512,
      retryAttempts: 0,
      logGroup: new logs.LogGroup(this, 'RollbackLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true },
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: versionsTable.tableName,
        TABLE_ARN: versionsTable.tableArn,
        BUCKET_NAME: artifactsBucket.bucketName,
        ROLLBACK_COOLDOWN_MINUTES: String(ROLLBACK_SETTINGS.cooldownMinutes),
        STABLE_AFTER_MINUTES: String(ROLLBACK_SETTINGS.stableAfterMinutes),
        LIVE_ERRORS_LOOKBACK_MINUTES: String(ROLLBACK_SETTINGS.liveErrorsLookbackMinutes),
        FUNCTION_ARN_PREFIX: `arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:`,
      },
    });

    // The rollback function's own role has no Lambda, S3 or DynamoDB permissions. It assumes this
    // role with a session policy scoped to a single function (see lambda/rollback/scoped.ts). This
    // role is the upper bound: registered functions only.
    const rollbackRole = new iam.Role(this, 'RollbackExecutionRole', {
      roleName: name('lambda-rollback-execution'),
      assumedBy: this.rollbackFunction.role!,
      maxSessionDuration: cdk.Duration.hours(1),
    });
    const registeredArns = registered.map(({ name: fn }) =>
      this.formatArn({ service: 'lambda', resource: 'function', resourceName: fn, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME }));
    if (registeredArns.length > 0) {
      rollbackRole.addToPolicy(new iam.PolicyStatement({
        actions: [
          'lambda:GetAlias',
          'lambda:ListVersionsByFunction',
          'lambda:UpdateAlias',
          // Restoring $LATEST: read the target version's package, upload it as $LATEST.
          'lambda:GetFunction',
          'lambda:UpdateFunctionCode',
        ],
        resources: registeredArns.flatMap((arn) => [arn, `${arn}:*`]),
      }));
      rollbackRole.addToPolicy(new iam.PolicyStatement({
        // Archive packages (PutObject) and let Lambda restore $LATEST from them (GetObject).
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: registered.map(({ name: fn }) => artifactsBucket.arnForObjects(`${fn}/*`)),
      }));
      rollbackRole.addToPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
        resources: [versionsTable.tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': registered.map(({ name: fn }) => fn) } },
      }));
    }
    rollbackRole.grantAssumeRole(this.rollbackFunction.role!);
    this.rollbackFunction.addEnvironment('ROLLBACK_ROLE_ARN', rollbackRole.roleArn);
    rollbackTopic.addSubscription(new snsSubs.LambdaSubscription(this.rollbackFunction));

    // --- Errors alarm -------------------------------------------------------------
    // Errors on live and $LATEST only; calls to `integration` (the tests) and to numbered versions
    // are ignored. One alarm, not one per resource, so a bad minute triggers a single rollback.
    // Resource dimension: "<fn>:live" for the alias, "<fn>" for unqualified calls ($LATEST),
    // "<fn>:$LATEST" when $LATEST is named explicitly.
    const errorsFor = (resource: string) => new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      dimensionsMap: { FunctionName: config.functionName, Resource: resource },
      period: cdk.Duration.minutes(1),
      statistic: cloudwatch.Stats.SUM,
    });
    const errorsAlarm = new cloudwatch.Alarm(this, 'ErrorsAlarm', {
      alarmName: config.errorsAlarmName,
      alarmDescription: `Errors on ${config.functionName}:${LIVE_ALIAS} or $LATEST; rolls back ${config.functionName}:${LIVE_ALIAS}`,
      metric: new cloudwatch.MathExpression({
        expression: 'FILL(live, 0) + FILL(unqualified, 0) + FILL(latest, 0)',
        usingMetrics: {
          live: errorsFor(`${config.functionName}:${LIVE_ALIAS}`),
          unqualified: errorsFor(config.functionName),
          latest: errorsFor(`${config.functionName}:$LATEST`),
        },
        label: `${config.functionName} errors (live + $LATEST)`,
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    errorsAlarm.addAlarmAction(new cwActions.SnsAction(rollbackTopic));

    // --- Scheduled check ------------------------------------------------------------
    // Every run syncs version metadata and packages of registered functions, marks live versions
    // stable, and - since CloudWatch only notifies when an alarm changes state - re-checks alarms
    // still in ALARM (the version rolled back to may fail too).
    new events.Rule(this, 'RollbackCheckSchedule', {
      ruleName: name('lambda-rollback-check'),
      description: `Every ${ROLLBACK_SETTINGS.checkIntervalMinutes} min: sync, mark stable versions, roll back again if a registered alarm is still in ALARM`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(ROLLBACK_SETTINGS.checkIntervalMinutes)),
      targets: [new targets.LambdaFunction(this.rollbackFunction, {
        event: events.RuleTargetInput.fromObject({ type: 'scheduled-check' }),
      })],
    });
    const registeredAlarmArns = registered.flatMap(({ alarms }) => [...alarms].map((alarm) =>
      this.formatArn({ service: 'cloudwatch', resource: 'alarm', resourceName: alarm, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })));
    if (registeredAlarmArns.length > 0) {
      this.rollbackFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ['cloudwatch:DescribeAlarms'],
        resources: registeredAlarmArns,
      }));
    }
    // enforceSSL gives the topic its own resource policy, which replaces the default one that let
    // the account publish - so CloudWatch must be allowed explicitly, for the registered alarms only.
    rollbackTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarms',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [rollbackTopic.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
        ArnLike: { 'aws:SourceArn': [errorsAlarm.alarmArn, ...registeredAlarmArns] },
      },
    }));
    // Reading the alias's error metric; GetMetricData doesn't support resource-level permissions.
    this.rollbackFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricData'],
      resources: ['*'],
    }));

    // --- Outputs --------------------------------------------------------------
    // Export names are unique per account and region: prefix ours so they never clash with the
    // api-user or frontend stacks in the same region.
    const out = (outputName: string, value: string) =>
      new cdk.CfnOutput(this, outputName, { value, exportName: name(`lambda-${outputName}`) });
    out('FunctionName', this.service.functionName);
    out('LiveAliasArn', liveAlias.functionArn);
    out('RollbackFunctionName', this.rollbackFunction.functionName);
    out('RollbackTopicArn', rollbackTopic.topicArn);
    out('VersionsTableName', versionsTable.tableName);
    out('ArtifactsBucketName', artifactsBucket.bucketName);
    out('ErrorsAlarmName', errorsAlarm.alarmName);
  }
}
