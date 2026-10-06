import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config.js';
import { ApiUserStack } from '../lib/api-user-stack.js';

const synth = (env: string) => {
  const app = new cdk.App();
  const stack = new ApiUserStack(app, `Test-${env}`, { config: getConfig(env) });
  return Template.fromStack(stack);
};

test('names the API per environment and deploys stage v1', () => {
  for (const env of ['dev', 'prod']) {
    const t = synth(env);
    t.hasResourceProperties('AWS::ApiGateway::RestApi', { Name: `api-user-${env}` });
    t.hasResourceProperties('AWS::ApiGateway::Stage', { StageName: 'v1' });
  }
});

test('exposes GET and POST on /users and /messages behind Cognito', () => {
  const t = synth('dev');
  t.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
  t.hasResourceProperties('AWS::ApiGateway::Authorizer', { Type: 'COGNITO_USER_POOLS' });
  for (const path of ['users', 'messages']) {
    t.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: path });
  }
  const methods = t.findResources('AWS::ApiGateway::Method');
  const secured = Object.values(methods).filter(
    (m: any) => m.Properties.AuthorizationType === 'COGNITO_USER_POOLS',
  );
  if (secured.length !== 4) throw new Error(`expected 4 Cognito-secured methods, got ${secured.length}`);
});

test('validates POST bodies', () => {
  synth('dev').hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'POST',
    RequestValidatorId: Match.anyValue(),
    RequestModels: { 'application/json': Match.anyValue() },
  });
});

test('rejects unknown environments', () => {
  try {
    getConfig('staging');
  } catch {
    return;
  }
  throw new Error('expected getConfig to throw');
});
