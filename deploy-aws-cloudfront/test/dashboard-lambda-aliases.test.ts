import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { handler } from '../lambda/dashboard-api/handler.js';
import { isAliasName, isVersion, pointAlias } from '../lambda/dashboard-api/lambda-aliases.js';
import { parseRegistered, registrationFor } from '../lambda/dashboard-api/registered-functions.js';
import { getConfig } from '../lib/config.js';
import { FrontendUserStack, registeredFunctions } from '../lib/frontend-user-stack.js';

const PROJECT = 'rollback-factory-demo';
const REGISTERED = [{ name: 'service-lambda-<env>', alias: 'live' }];

test('resolves a registered function to its environment\'s rollback service and watched alias', () => {
  assert.deepEqual(registrationFor('service-lambda-prod', REGISTERED, PROJECT), {
    rollbackService: 'rollback-factory-demo-rollback-service-prod', alias: 'live',
  });
  for (const name of ['service-lambda', 'service-lambda-dev-copy', 'my-service-lambda-dev', 'rollback-factory-demo-handler-dev']) {
    assert.equal(registrationFor(name, REGISTERED, PROJECT), undefined, name);
  }
});

test('reads the registered functions from rollback-config.json, enabled ones only', () => {
  assert.deepEqual(registeredFunctions(), [{ name: 'service-lambda-<env>', alias: 'live' }]);
  assert.deepEqual(parseRegistered(JSON.stringify([...REGISTERED, { name: 'no-placeholder', alias: 'live' }])), REGISTERED);
  assert.deepEqual(parseRegistered(undefined), []);
});

test('passes them to the dashboard API', () => {
  const app = new cdk.App();
  const t = Template.fromStack(new FrontendUserStack(app, 'Test', { config: getConfig('dev', {}) }));
  const [fn] = Object.values(t.findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: 'rollback-factory-demo-frontend-dashboard-api-dev' },
  })) as any[];
  assert.deepEqual(JSON.parse(fn.Properties.Environment.Variables.REGISTERED_FUNCTIONS), REGISTERED);
});

const fakeLambda = (answer: { FunctionError?: string; Payload?: string }) => {
  const sent: any[] = [];
  const client = {
    send: async (command: any) => {
      sent.push(command);
      if (!(command instanceof InvokeCommand)) throw new Error(`unexpected ${command.constructor.name}`);
      return { ...answer, Payload: answer.Payload && new TextEncoder().encode(answer.Payload) };
    },
  };
  return { client: client as unknown as LambdaClient, sent };
};

test('asks the environment\'s rollback service to point the alias', async () => {
  const lambda = fakeLambda({ Payload: '{"pointed":true,"from":3,"to":1,"kind":"rollback"}' });
  const outcome = await pointAlias(lambda.client, REGISTERED, PROJECT, 'service-lambda-dev', { aliasName: 'live', version: 1 });
  assert.deepEqual(outcome, { ok: true, result: { pointed: true, from: 3, to: 1, kind: 'rollback' } });
  assert.equal(lambda.sent[0].input.FunctionName, 'rollback-factory-demo-rollback-service-dev');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(lambda.sent[0].input.Payload)), {
    type: 'point-alias', functionName: 'service-lambda-dev', aliasName: 'live', version: 1, actor: 'dashboard',
  });
});

test('refuses unregistered functions without invoking anything, and reports what the service refused', async () => {
  const lambda = fakeLambda({ Payload: '{}' });
  const refused = await pointAlias(lambda.client, REGISTERED, PROJECT, 'rollback-factory-demo-handler-dev', { aliasName: 'live', version: 1 });
  assert.equal((refused as { status: number }).status, 400);
  assert.equal(lambda.sent.length, 0);

  const skipped = await pointAlias(fakeLambda({ Payload: '{"rolledBack":false,"reason":"service-lambda-dev:live already points to version 1"}' }).client,
    REGISTERED, PROJECT, 'service-lambda-dev', { aliasName: 'live', version: 1 });
  assert.deepEqual(skipped, { ok: false, status: 409, message: 'service-lambda-dev:live already points to version 1' });

  const failed = await pointAlias(fakeLambda({ FunctionError: 'Unhandled', Payload: '{"errorMessage":"secret details"}' }).client,
    REGISTERED, PROJECT, 'service-lambda-dev', { aliasName: 'live', version: 1 });
  assert.deepEqual(failed, { ok: false, status: 502, message: 'The rollback service could not point service-lambda-dev:live to version 1' });
});

test('validates alias names and versions', () => {
  for (const ok of ['live', 'integration', 'v2_beta-1']) assert.ok(isAliasName(ok), ok);
  for (const bad of ['', '-live', 'live:1', '$LATEST', 'a'.repeat(129), 3]) assert.ok(!isAliasName(bad), String(bad));
  assert.ok(isVersion(1) && isVersion(42));
  for (const bad of [0, -1, 1.5, '3', '$LATEST']) assert.ok(!isVersion(bad), String(bad));
});

test('points aliases only with POST and a valid body, checked before calling AWS', async () => {
  const send = (path: string, method: string, body?: string) =>
    handler({ rawPath: path, body, requestContext: { http: { method } } });
  const url = '/api/lambda-functions/service-lambda-dev/point-alias';
  assert.equal((await send(url, 'GET')).statusCode, 405);
  for (const body of [undefined, 'not json', '{}', '{"aliasName":"live"}', '{"aliasName":"live","version":"2"}', '{"aliasName":"$LATEST","version":2}']) {
    assert.equal((await send(url, 'POST', body)).statusCode, 400, String(body));
  }
  assert.equal((await send('/api/lambda-functions/arn:aws:lambda:x/point-alias', 'POST', '{"aliasName":"live","version":2}')).statusCode, 400);
  assert.equal((await send('/api/api-gateways/abcdefghij/point-alias', 'POST', '{}')).statusCode, 405);
});
