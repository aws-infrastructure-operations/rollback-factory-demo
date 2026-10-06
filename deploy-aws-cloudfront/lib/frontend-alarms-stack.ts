import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { EnvConfig } from './config.js';

export interface FrontendAlarmsStackProps extends cdk.StackProps {
  config: EnvConfig;
  /** The distribution in the main stack (a cross-region reference). */
  distributionId: string;
}

/**
 * us-east-1: the CloudFront 4xx/5xx rate alarms of frontend-user-<env>. They publish to the rollback
 * service's us-east-1 topic (rollback-service, deployed first), whose Lambda routes
 * rollback-factory-demo-cloudfront-* alarms to its CloudFront manager.
 */
export class FrontendAlarmsStack extends cdk.Stack {
  readonly alarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: FrontendAlarmsStackProps) {
    super(scope, id, props);
    const { config, distributionId } = props;
    const name = config.resourceName;
    const rollbackTopic = sns.Topic.fromTopicArn(this, 'RollbackTopic',
      this.formatArn({ service: 'sns', resource: config.rollbackTopicName }));

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
        + `${config.frontendName}. Triggers the rollback service via SNS.`,
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
    for (const alarm of this.alarms) alarm.addAlarmAction(new cwActions.SnsAction(rollbackTopic));

    // --- Outputs --------------------------------------------------------------
    const out = (outputName: string, value: string) =>
      new cdk.CfnOutput(this, outputName, { value, exportName: name(`frontend-${outputName}`) });
    out('Alarm4xxName', this.alarms[0].alarmName);
    out('Alarm5xxName', this.alarms[1].alarmName);
  }
}
