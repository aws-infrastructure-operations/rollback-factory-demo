import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EnvConfig } from './config.js';

export interface FrontendAlarmsStackProps extends cdk.StackProps {
  config: EnvConfig;
}

/** us-east-1: CloudFront 4xx/5xx alarms + SNS topic (FE-07) and the rollback Lambda (FE-08). */
export class FrontendAlarmsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontendAlarmsStackProps) {
    super(scope, id, props);
  }
}
