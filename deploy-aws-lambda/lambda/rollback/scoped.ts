// The rollback function's own role has no Lambda, S3 or DynamoDB permissions; it can only assume the
// rollback role, and a session policy narrows that role down to one function: its alias and versions,
// its folder in the artifacts bucket and its items in the versions table.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { ScopedClients } from './rollback.js';

export interface ScopeSettings {
  roleArn: string;
  /** e.g. arn:aws:lambda:eu-central-1:123456789012:function: */
  functionArnPrefix: string;
  tableArn: string;
  bucketName: string;
}

/** The session policy for one function (also checked by the unit tests). */
export function sessionPolicy(functionName: string, { functionArnPrefix, tableArn, bucketName }: ScopeSettings) {
  const functionArn = `${functionArnPrefix}${functionName}`;
  const partition = functionArnPrefix.split(':')[1] || 'aws';
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          'lambda:GetAlias',
          'lambda:ListVersionsByFunction',
          'lambda:UpdateAlias',
          'lambda:GetFunction',
          'lambda:UpdateFunctionCode',
        ],
        Resource: [functionArn, `${functionArn}:*`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject'],
        Resource: `arn:${partition}:s3:::${bucketName}/${functionName}/*`,
      },
      {
        Effect: 'Allow',
        Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
        Resource: tableArn,
        Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [functionName] } },
      },
    ],
  };
}

export function scopedClientsFactory(settings: ScopeSettings, sts = new STSClient({})) {
  return async function scopedClients(functionName: string): Promise<ScopedClients> {
    const { Credentials } = await sts.send(new AssumeRoleCommand({
      RoleArn: settings.roleArn,
      RoleSessionName: `rollback-${functionName}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64),
      DurationSeconds: 900,
      Policy: JSON.stringify(sessionPolicy(functionName, settings)),
    }));
    if (!Credentials) throw new Error(`No credentials returned for ${functionName}`);
    console.log(`Using credentials scoped to ${settings.functionArnPrefix}${functionName}`);

    const credentials = {
      accessKeyId: Credentials.AccessKeyId!,
      secretAccessKey: Credentials.SecretAccessKey!,
      sessionToken: Credentials.SessionToken,
      expiration: Credentials.Expiration,
    };
    return {
      lambda: new LambdaClient({ credentials }),
      s3: new S3Client({ credentials }),
      ddb: new DynamoDBClient({ credentials }),
    };
  };
}
