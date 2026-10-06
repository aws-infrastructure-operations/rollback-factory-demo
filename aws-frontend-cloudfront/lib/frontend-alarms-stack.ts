import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { EnvConfig } from './config.js';

export interface FrontendAlarmsStackProps extends cdk.StackProps {
  config: EnvConfig;
  /** The distribution in the main stack (a cross-region reference). */
  distributionId: string;
  /** Region of the main stack, where the deployments table lives. */
  mainRegion: string;
}

/** us-east-1: CloudFront 4xx/5xx alarms, their SNS topic and the rollback Lambda it invokes. */
export class FrontendAlarmsStack extends cdk.Stack {
  readonly alarmTopic: sns.Topic;
  readonly alarms: cloudwatch.Alarm[];
  readonly rollbackFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: FrontendAlarmsStackProps) {
    super(scope, id, props);
    const { config, distributionId, mainRegion } = props;
    const name = config.resourceName;

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: name('frontend-notifications'),
      displayName: `${config.frontendName} alarms`,
      enforceSSL: true,
    });
    if (config.alarms.email) {
      this.alarmTopic.addSubscription(new snsSubs.EmailSubscription(config.alarms.email));
    }

    // CloudFront publishes its metrics only in us-east-1, with Region=Global.
    const metric = (metricName: string, statistic: string) => new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName,
      dimensionsMap: { DistributionId: distributionId, Region: 'Global' },
      statistic,
      period: cdk.Duration.minutes(1),
    });
    const { alarms: a } = config;
    const errorClasses = [
      { kind: '4xx', metricName: '4xxErrorRate', key: 'error4xx', threshold: a.error4xxRatePercent, minRequests: a.minRequests4xx },
      { kind: '5xx', metricName: '5xxErrorRate', key: 'error5xx', threshold: a.error5xxRatePercent, minRequests: a.minRequests5xx },
    ] as const;

    this.alarms = errorClasses.map((c) => new cloudwatch.Alarm(this, `Alarm${c.kind}`, {
      alarmName: config.alarmNames[c.key],
      alarmDescription: `More than ${c.threshold}% ${c.kind} responses (min ${c.minRequests} requests/min) on `
        + `${config.frontendName}. Triggers the rollback Lambda via SNS.`,
      // The error rates are already percentages; minutes with too few requests count as 0,
      // so a few intentional 4xx (the smoke test's unknown path) can't trigger a rollback.
      metric: new cloudwatch.MathExpression({
        expression: `IF(requests >= ${c.minRequests}, rate, 0)`,
        usingMetrics: { requests: metric('Requests', cloudwatch.Stats.SUM), rate: metric(c.metricName, cloudwatch.Stats.AVERAGE) },
        label: `${c.kind} rate %`,
        period: cdk.Duration.minutes(1),
      }),
      threshold: c.threshold,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: a.evaluationPeriods,
      datapointsToAlarm: a.datapointsToAlarm,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled: a.notificationsEnabled,
    }));
    for (const alarm of this.alarms) alarm.addAlarmAction(new cwActions.SnsAction(this.alarmTopic));

    // enforceSSL gives the topic its own resource policy, which replaces the default
    // one that let the account publish - so CloudWatch must be allowed explicitly
    // (only for these alarms in this account, to avoid confused-deputy access).
    this.alarmTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarms',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [this.alarmTopic.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
        ArnLike: { 'aws:SourceArn': this.alarms.map((alarm) => alarm.alarmArn) },
      },
    }));

    // --- Rollback ---------------------------------------------------------------
    this.rollbackFunction = new NodejsFunction(this, 'RollbackFunction', {
      functionName: name('frontend-rollback'),
      description: `Switches ${config.frontendName} back to the previous verified release on alarm`,
      entry: path.join(__dirname, '..', 'lambda', 'rollback', 'handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // reads the history, updates the distribution and the table; doesn't wait for the deploy
      timeout: cdk.Duration.seconds(30),
      retryAttempts: 0,
      environment: {
        FRONTEND_NAME: config.frontendName,
        DISTRIBUTION_ID: distributionId,
        DEPLOYMENTS_TABLE: config.deploymentsTableName,
        DEPLOYMENTS_TABLE_REGION: mainRegion,
        ROLLBACK_WINDOW_MINUTES: String(config.rollbackWindowMinutes),
        ALARM_NAMES: Object.values(config.alarmNames).join(','),
      },
      logGroup: new logs.LogGroup(this, 'RollbackLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true },
    });
    // Only this frontend's alarms trigger a rollback, even if something else publishes to the topic.
    this.alarmTopic.addSubscription(new snsSubs.LambdaSubscription(this.rollbackFunction, {
      filterPolicyWithMessageBody: {
        AlarmName: sns.FilterOrPolicy.filter(sns.SubscriptionFilter.stringFilter({
          allowlist: Object.values(config.alarmNames),
        })),
      },
    }));

    // The table is in the main region; its name is fixed, so no cross-region reference is needed.
    dynamodb.TableV2.fromTableArn(this, 'DeploymentsTable', cdk.Arn.format({
      service: 'dynamodb',
      region: mainRegion,
      resource: 'table',
      resourceName: config.deploymentsTableName,
    }, this)).grantReadWriteData(this.rollbackFunction);
    this.rollbackFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution', 'cloudfront:CreateInvalidation'],
      resources: [cdk.Arn.format({ service: 'cloudfront', region: '', resource: 'distribution', resourceName: distributionId }, this)],
    }));

    // --- Outputs --------------------------------------------------------------
    const out = (outputName: string, value: string) =>
      new cdk.CfnOutput(this, outputName, { value, exportName: name(`frontend-${outputName}`) });
    out('AlarmTopicArn', this.alarmTopic.topicArn);
    out('Alarm4xxName', this.alarms[0].alarmName);
    out('Alarm5xxName', this.alarms[1].alarmName);
    out('RollbackFunctionName', this.rollbackFunction.functionName);
  }
}
