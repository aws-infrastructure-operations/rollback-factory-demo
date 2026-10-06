import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EnvConfig } from './config.js';

export interface FrontendUserStackProps extends cdk.StackProps {
  config: EnvConfig;
}

/** Main region: site bucket + CloudFront distribution (FE-02), deployments bucket and table (FE-04, FE-05). */
export class FrontendUserStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontendUserStackProps) {
    super(scope, id, props);
  }
}
