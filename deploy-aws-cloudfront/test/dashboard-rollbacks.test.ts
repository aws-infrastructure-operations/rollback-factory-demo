import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { route as handler } from '../lambda/dashboard-api/handler.js';
import { listRollbacks, MAX_ROLLBACKS } from '../lambda/dashboard-api/rollbacks.js';

const PROJECT = 'rollback-factory-demo';
const REGISTERED = [{ name: 'service-lambda-<env>', alias: 'live' }];

/** Items per table (newest first, as the queries ask); a table not listed doesn't exist. */
const fakeDynamo = (tables: Record<string, Array<Record<string, unknown>>>) => {
  const sent: QueryCommand[] = [];
  const client = {
    send: async (command: any) => {
      if (!(command instanceof QueryCommand)) throw new Error(`unexpected ${command.constructor.name}`);
      sent.push(command);
      const items = tables[command.input.TableName!];
      if (!items) throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
      // the template archive holds both stacks of an environment: answer for the one asked about
      const key = Object.values(command.input.ExpressionAttributeValues ?? {})[0];
      return { Items: items.filter((item) => item.stackName === undefined || item.stackName === key) };
    },
  };
  return { client: client as unknown as DynamoDBDocumentClient, sent };
};

const TABLES = {
  'rollback-factory-demo-deployments-dev': [
    {
      deployedAt: '2026-10-07T12:30:00.000Z', deploymentId: 'new111', source: 'rollback',
      actor: 'alarm:rollback-factory-demo-apigateway-api-user-5xx-rate-dev', rolledBackFrom: '2026-10-07T12:00:00.000Z',
      description: 'Rollback to 2026-10-07T10:00:00.000Z (good00) after alarm: rollback-factory-demo-apigateway-api-user-5xx-rate-dev',
    },
    { deployedAt: '2026-10-07T12:00:00.000Z', deploymentId: 'bad999', source: 'cicd', actor: 'github:someone', rolledBackAt: '2026-10-07T12:30:00.000Z' },
    { deployedAt: '2026-10-07T11:00:00.000Z', deploymentId: 'rst222', source: 'restore', actor: 'dashboard', description: 'Restore to 2026-10-06T09:00:00.000Z (old333): checking the old routes' },
    { deployedAt: '2026-10-07T10:00:00.000Z', deploymentId: 'good00', source: 'cicd', actor: 'github:someone' },
  ],
  'rollback-factory-demo-frontend-deployments-prod': [
    {
      deployedAt: '2026-10-07T13:00:00.000Z', releaseId: '20261007T090000Z', previousReleaseId: '20261007T120000Z', source: 'rollback',
      actor: 'alarm:rollback-factory-demo-cloudfront-frontend-user-4xx-rate-prod', rolledBackFrom: '2026-10-07T12:50:00.000Z',
      description: 'Rollback from 20261007T120000Z to 20261007T090000Z after alarm: rollback-factory-demo-cloudfront-frontend-user-4xx-rate-prod',
    },
    { deployedAt: '2026-10-07T12:50:00.000Z', releaseId: '20261007T120000Z', source: 'cicd', actor: 'github:someone' },
  ],
  'rollback-factory-demo-lambda-archive-dev': [
    { functionName: 'service-lambda-dev', sk: 'VERSION#0000000005', version: 5, rolledBackAt: '2026-10-07T14:00:00.000Z', rolledBackBy: 'rollback-service', rolledBackTo: 4, rollbackReason: 'alarm rollback-factory-demo-lambda-service-lambda-errors-dev' },
    { functionName: 'service-lambda-dev', sk: 'VERSION#0000000004', version: 4, liveAt: '2026-10-07T09:00:00.000Z' },
    { functionName: 'service-lambda-dev', sk: 'VERSION#0000000003', version: 3, rolledBackAt: '2026-10-06T08:00:00.000Z', rolledBackBy: 'dashboard', rollbackReason: 'live pointed to v2 by dashboard' },
  ],
};

test('lists the API, frontend and Lambda rollbacks of every environment, newest first', async () => {
  const { client } = fakeDynamo(TABLES);
  const rollbacks = await listRollbacks(client, PROJECT, REGISTERED);

  assert.deepEqual(rollbacks.map((r) => `${r.kind} ${r.target} ${r.at}`), [
    'lambda service-lambda-dev 2026-10-07T14:00:00.000Z',
    'frontend frontend-user-prod 2026-10-07T13:00:00.000Z',
    'api api-user-dev 2026-10-07T12:30:00.000Z',
    'api api-user-dev 2026-10-07T11:00:00.000Z',
    'lambda service-lambda-dev 2026-10-06T08:00:00.000Z',
  ]);
  // an alarm rollback of the API: from the deployment rolled back, to the one restored
  assert.deepEqual(rollbacks[2], {
    kind: 'api', env: 'dev', target: 'api-user-dev', at: '2026-10-07T12:30:00.000Z', trigger: 'alarm',
    by: 'rollback-factory-demo-apigateway-api-user-5xx-rate-dev', from: 'bad999', to: 'good00',
  });
  // a restore by hand, with the reason given
  assert.deepEqual([rollbacks[3].trigger, rollbacks[3].by, rollbacks[3].to, rollbacks[3].reason], ['manual', 'dashboard', 'old333', 'checking the old routes']);
  // the frontend: release ids
  assert.deepEqual([rollbacks[1].env, rollbacks[1].trigger, rollbacks[1].from, rollbacks[1].to], ['prod', 'alarm', '20261007T120000Z', '20261007T090000Z']);
  // the Lambda: the version left, where live went (when recorded), the alarm
  assert.deepEqual(rollbacks[0], {
    kind: 'lambda', env: 'dev', target: 'service-lambda-dev', at: '2026-10-07T14:00:00.000Z', trigger: 'alarm',
    by: 'rollback-factory-demo-lambda-service-lambda-errors-dev', from: 'v5', to: 'v4',
  });
  assert.deepEqual([rollbacks[4].trigger, rollbacks[4].by, rollbacks[4].from, rollbacks[4].to, rollbacks[4].reason], ['manual', 'dashboard', 'v3', undefined, 'live pointed to v2 by dashboard']);
});

const sha = (c: string) => c.repeat(64);
const STACK_TABLES = {
  'rollback-factory-demo-stack-templates-dev': [
    // the dashboard restored the lambda stack to its baseline, replacing the template rolled back to
    {
      stackName: 'deploy-aws-lambda-dev', deployedAt: '2026-10-09T15:00:00.000Z', templateSha256: sha('a'), source: 'restore',
      actor: 'dashboard:someone@example.com', restoredFrom: '2026-10-09T10:00:00.000Z', replacedTemplateSha256: sha('c'),
      description: 'Restore to the template archived at 2026-10-09T10:00:00.000Z: back to the baseline',
    },
    // deploy-test-rollback: the tests failed on b, the stack went back to c
    {
      stackName: 'deploy-aws-lambda-dev', deployedAt: '2026-10-09T12:10:00.000Z', templateSha256: sha('c'), source: 'rollback',
      actor: 'github:someone', rolledBackFrom: '2026-10-09T12:00:00.000Z',
    },
    { stackName: 'deploy-aws-lambda-dev', deployedAt: '2026-10-09T12:00:00.000Z', templateSha256: sha('b'), source: 'cicd', rolledBackAt: '2026-10-09T12:05:00.000Z' },
    { stackName: 'deploy-aws-lambda-dev', deployedAt: '2026-10-09T11:00:00.000Z', templateSha256: sha('c'), source: 'cicd', stable: true },
    { stackName: 'deploy-aws-lambda-dev', deployedAt: '2026-10-09T10:00:00.000Z', templateSha256: sha('a'), source: 'baseline', stable: true },
    // a restore recorded before the replaced template was: the change starts from "?"
    { stackName: 'deploy-aws-api-gateway-dev', deployedAt: '2026-10-09T09:00:00.000Z', templateSha256: sha('d'), source: 'restore', actor: 'dashboard' },
  ],
};

test('lists the stack rollbacks after failed tests and the restores, by template hash', async () => {
  const { client } = fakeDynamo(STACK_TABLES);
  const rollbacks = await listRollbacks(client, PROJECT, REGISTERED);
  assert.deepEqual(rollbacks, [
    {
      kind: 'stack', env: 'dev', target: 'deploy-aws-lambda-dev', at: '2026-10-09T15:00:00.000Z', trigger: 'manual',
      by: 'dashboard:someone@example.com', from: 'cccccccccccc', to: 'aaaaaaaaaaaa', reason: 'back to the baseline',
    },
    {
      kind: 'stack', env: 'dev', target: 'deploy-aws-lambda-dev', at: '2026-10-09T12:10:00.000Z', trigger: 'tests',
      by: 'github:someone', from: 'bbbbbbbbbbbb', to: 'cccccccccccc', reason: 'integration tests failed',
    },
    { kind: 'stack', env: 'dev', target: 'deploy-aws-api-gateway-dev', at: '2026-10-09T09:00:00.000Z', trigger: 'manual', by: 'dashboard', to: 'dddddddddddd' },
  ]);
});

test('queries each environment\'s tables by their own key; missing tables are skipped', async () => {
  const { client, sent } = fakeDynamo({});
  assert.deepEqual(await listRollbacks(client, PROJECT, REGISTERED), []);
  const asked = sent.map((c) => `${c.input.TableName} ${Object.values(c.input.ExpressionAttributeValues ?? {})[0]}`).sort();
  assert.deepEqual(asked, [
    'rollback-factory-demo-deployments-dev api-user-dev',
    'rollback-factory-demo-deployments-prod api-user-prod',
    'rollback-factory-demo-frontend-deployments-dev frontend-user-dev',
    'rollback-factory-demo-frontend-deployments-prod frontend-user-prod',
    'rollback-factory-demo-lambda-archive-dev service-lambda-dev',
    'rollback-factory-demo-lambda-archive-prod service-lambda-prod',
    'rollback-factory-demo-stack-templates-dev deploy-aws-api-gateway-dev',
    'rollback-factory-demo-stack-templates-dev deploy-aws-lambda-dev',
    'rollback-factory-demo-stack-templates-prod deploy-aws-api-gateway-prod',
    'rollback-factory-demo-stack-templates-prod deploy-aws-lambda-prod',
  ]);
  assert.ok(MAX_ROLLBACKS >= 50);
});

test('GET /api/rollbacks is read-only', async () => {
  const event = (method: string) => ({ rawPath: '/api/rollbacks', requestContext: { http: { method } } }) as any;
  assert.equal((await handler(event('POST'))).statusCode, 405);
  assert.equal((await handler(event('DELETE'))).statusCode, 405);
});
