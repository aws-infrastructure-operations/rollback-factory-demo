import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { EnvConfig, INTEGRATION_ALIAS, LIVE_ALIAS } from './config.js';

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
 * service-lambda-<env> with its `integration` and `live` aliases and its errors alarm. The alarm
 * publishes to the rollback service (rollback-service, deployed first), whose Lambda manager archives
 * every version and moves `live` back to the previous version that went live.
 */
export class LambdaServiceStack extends cdk.Stack {
  readonly service: NodejsFunction;

  constructor(scope: Construct, id: string, props: LambdaServiceStackProps) {
    super(scope, id, props);
    const { config } = props;
    const name = config.resourceName;

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
      alarmDescription: `Errors on ${config.functionName}:${LIVE_ALIAS} or $LATEST; the rollback service rolls back ${config.functionName}:${LIVE_ALIAS}`,
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
    // A pull request's environment has no rollback service: its alarm exists but notifies nobody.
    if (!config.pr) {
      errorsAlarm.addAlarmAction(new cwActions.SnsAction(sns.Topic.fromTopicArn(this, 'RollbackTopic',
        this.formatArn({ service: 'sns', resource: config.rollbackTopicName }))));
    }

    // --- Outputs --------------------------------------------------------------
    // Export names are unique per account and region: prefix ours so they never clash with the
    // api-user or frontend stacks in the same region.
    const out = (outputName: string, value: string) =>
      new cdk.CfnOutput(this, outputName, { value, exportName: name(`lambda-${outputName}`) });
    out('FunctionName', this.service.functionName);
    out('LiveAliasArn', liveAlias.functionArn);
    out('ErrorsAlarmName', errorsAlarm.alarmName);
  }
}
