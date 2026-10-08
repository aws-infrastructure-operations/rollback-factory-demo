import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config.js';
import { FrontendUserStack } from '../lib/frontend-user-stack.js';

const synth = (env: string) => Template.fromStack(new FrontendUserStack(new cdk.App(), `Test-${env}`, { config: getConfig(env) }));
const dev = synth('dev');

test('one dashboard user pool per environment, invite only: nobody can sign up', () => {
  dev.resourceCountIs('AWS::Cognito::UserPool', 1);
  dev.hasResourceProperties('AWS::Cognito::UserPool', {
    UserPoolName: 'rollback-factory-demo-dashboard-users-dev',
    AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    UsernameAttributes: ['email'],
    Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12, RequireSymbols: true, TemporaryPasswordValidityDays: 7 }) },
  });
});

test('a browser client: no secret, password and refresh sign-in only, no user enumeration', () => {
  dev.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  const [client] = Object.values(dev.findResources('AWS::Cognito::UserPoolClient')) as any[];
  const props = client.Properties;
  assert.equal(props.ClientName, 'rollback-factory-demo-dashboard-client-dev');
  assert.equal(props.GenerateSecret, false);
  assert.deepEqual([...props.ExplicitAuthFlows].sort(), ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_PASSWORD_AUTH']);
  assert.equal(props.PreventUserExistenceErrors, 'ENABLED');
  assert.equal(props.EnableTokenRevocation, true);
});

test('the dashboard API knows the pool and client whose tokens it accepts', () => {
  dev.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'rollback-factory-demo-frontend-dashboard-api-dev',
    Environment: { Variables: Match.objectLike({ USER_POOL_ID: { Ref: Match.stringLikeRegexp('^DashboardUserPool') }, USER_POOL_CLIENT_ID: { Ref: Match.stringLikeRegexp('^DashboardUserPool') } }) },
  });
  const outputs = dev.findOutputs('*');
  assert.ok(outputs.DashboardUserPoolId && outputs.DashboardUserPoolClientId);
});

test('prod keeps its users if the stack is deleted; dev does not', () => {
  const policy = (t: Template) => (Object.values(t.findResources('AWS::Cognito::UserPool'))[0] as any).DeletionPolicy;
  assert.equal(policy(synth('prod')), 'Retain');
  assert.equal(policy(dev), 'Delete');
});
