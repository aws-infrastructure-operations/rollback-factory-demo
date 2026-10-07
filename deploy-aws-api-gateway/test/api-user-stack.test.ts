import { strict as assert } from 'node:assert';
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

test('exposes GET and POST on /users, /messages and /orders behind Cognito', () => {
  const t = synth('dev');
  t.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
  t.hasResourceProperties('AWS::ApiGateway::Authorizer', { Type: 'COGNITO_USER_POOLS' });
  for (const path of ['users', 'messages', 'orders']) {
    t.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: path });
  }
  const methods = t.findResources('AWS::ApiGateway::Method');
  const secured = Object.values(methods).filter(
    (m: any) => m.Properties.AuthorizationType === 'COGNITO_USER_POOLS',
  );
  if (secured.length !== 6) throw new Error(`expected 6 Cognito-secured methods, got ${secured.length}`);
});

test('validates POST bodies', () => {
  synth('dev').hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'POST',
    RequestValidatorId: Match.anyValue(),
    RequestModels: { 'application/json': Match.anyValue() },
  });
});

test('rejects unknown environments', () => {
  assert.throws(() => getConfig('qa'), /Unknown env "qa"/);
  assert.throws(() => getConfig(undefined), /Unknown env/);
});

test('accepts testing and staging, which drop their data like dev', () => {
  for (const env of ['testing', 'staging']) {
    const config = getConfig(env);
    assert.equal(config.apiName, `api-user-${env}`);
    assert.equal(config.stackName, `deploy-aws-api-gateway-${env}`);
    assert.equal(config.retainData, false);
  }
  assert.equal(getConfig('prod').retainData, true);
});

test('names every resource rollback-factory-demo-<resource>-<env>', () => {
  const config = getConfig('prod');
  assert.equal(config.stackName, 'deploy-aws-api-gateway-prod');
  assert.equal(config.resourceName('users'), 'rollback-factory-demo-users-prod');
  const t = synth('prod');
  t.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolName: 'rollback-factory-demo-users-prod' });
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', { ClientName: 'rollback-factory-demo-client-prod' });
  t.hasResourceProperties('AWS::ApiGateway::Authorizer', { Name: 'rollback-factory-demo-cognito-prod' });
  t.hasOutput('ApiId', { Export: { Name: 'rollback-factory-demo-ApiId-prod' } });
});

test('allows browsers to call the API from any origin (CORS)', () => {
  const t = synth('dev');
  const methods = Object.values(t.findResources('AWS::ApiGateway::Method')) as any[];
  const preflights = methods.filter((m) => m.Properties.HttpMethod === 'OPTIONS');
  // root + /users + /messages + /orders; preflights must not require a token
  assert.equal(preflights.length, 4);
  for (const m of preflights) assert.equal(m.Properties.AuthorizationType, 'NONE');
  t.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'OPTIONS',
    Integration: Match.objectLike({
      IntegrationResponses: Match.arrayWith([Match.objectLike({
        ResponseParameters: Match.objectLike({
          'method.response.header.Access-Control-Allow-Origin': "'*'",
          'method.response.header.Access-Control-Allow-Headers': "'Authorization,Content-Type'",
        }),
      })]),
    }),
  });
  for (const type of ['DEFAULT_4XX', 'DEFAULT_5XX']) {
    t.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
      ResponseType: type,
      ResponseParameters: { 'gatewayresponse.header.Access-Control-Allow-Origin': "'*'" },
    });
  }
});
