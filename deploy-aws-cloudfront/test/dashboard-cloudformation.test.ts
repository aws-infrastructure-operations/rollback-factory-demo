import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CloudFormationClient, DescribeStacksCommand, GetTemplateCommand } from '@aws-sdk/client-cloudformation';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  getStackDetails, isRestorableStack, listStacks, restoreStackTemplate, templateSha256,
} from '../lambda/dashboard-api/cloudformation-stacks.js';
import { parseOperationId } from '../lambda/dashboard-api/operations.js';

const PROJECT = 'rollback-factory-demo';
const STACK = 'deploy-aws-lambda-dev';
// what CloudFormation returns: the template as CDK wrote it, pretty-printed, keys in its own order
const RUNNING = JSON.stringify({ Resources: { B: { Type: 'x', Properties: { z: 1, a: [true, null, 'é'] } } }, Outputs: {} }, null, 1);
const OLD = '{"Resources":{}}';
const sha = (compactSorted: string) => createHash('sha256').update(`${compactSorted}\n`).digest('hex');
const RUNNING_SHA = sha('{"Outputs":{},"Resources":{"B":{"Properties":{"a":[true,null,"é"],"z":1},"Type":"x"}}}');

const record = (deployedAt: string, templateSha256: string, extra: Record<string, unknown> = {}) => ({
  stackName: STACK, deployedAt, templateBucket: 'bucket', templateKey: `${STACK}/${deployedAt}/template.json`,
  templateSha256, parameterKeys: '["BootstrapVersion"]', source: 'cicd', ...extra,
});
const RECORDS = [
  record('2026-10-09T12:00:00.000Z', RUNNING_SHA, { commitSha: 'abc1234def', runUrl: 'https://github.com/o/r/actions/runs/1' }),
  record('2026-10-09T11:00:00.000Z', sha(OLD), { stable: false, rolledBackAt: '2026-10-09T11:05:00.000Z' }),
  record('2026-10-09T10:00:00.000Z', sha(OLD), { source: 'baseline', stable: true, runUrl: 'https://github.com//actions/runs/' }),
];

const fakeCfn = (status = 'UPDATE_COMPLETE') => ({
  send: async (command: any) => {
    if (command instanceof DescribeStacksCommand) {
      if (command.input.StackName !== STACK) throw new Error(`Stack with id ${command.input.StackName} does not exist`);
      return { Stacks: [{
        StackName: STACK, StackStatus: status, CreationTime: new Date('2026-10-01T00:00:00Z'), LastUpdatedTime: new Date('2026-10-09T12:00:00Z'),
        RoleARN: 'arn:aws:iam::1:role/cdk-cfn-exec', Outputs: [{ OutputKey: 'FunctionName', OutputValue: 'service-lambda-dev' }],
      }] };
    }
    if (command instanceof GetTemplateCommand) return { TemplateBody: RUNNING };
    throw new Error(`unexpected ${command.constructor.name}`);
  },
}) as unknown as CloudFormationClient;

const fakeDynamo = () => ({
  send: async (command: any) => {
    if (!(command instanceof QueryCommand)) throw new Error(`unexpected ${command.constructor.name}`);
    assert.equal(command.input.TableName, 'rollback-factory-demo-stack-templates-dev');
    return { Items: RECORDS };
  },
}) as unknown as DynamoDBDocumentClient;

const fakeLambda = () => {
  const sent: any[] = [];
  return { sent, client: { send: async (command: any) => { assert.ok(command instanceof InvokeCommand); sent.push(command.input); return {}; } } as unknown as LambdaClient };
};

test('hashes a template like jq -cS does: compact, keys sorted, with a newline', () => {
  assert.equal(templateSha256(RUNNING), RUNNING_SHA);
  assert.equal(templateSha256('Resources: {}'), undefined, 'YAML is not hashed');
});

test('only the API and Lambda stacks of dev and prod are restorable', () => {
  for (const name of ['deploy-aws-api-gateway-dev', 'deploy-aws-lambda-prod']) assert.ok(isRestorableStack(name), name);
  for (const name of ['deploy-aws-lambda-pr-12', 'rollback-service-dev', 'deploy-aws-cloudfront-dev', 'deploy-aws-lambda-dev/x']) {
    assert.ok(!isRestorableStack(name), name);
  }
});

test('lists the four stacks, those not deployed without a status', async () => {
  const stacks = await listStacks(fakeCfn());
  assert.deepEqual(stacks.map((s) => [s.name, s.status]), [
    ['deploy-aws-api-gateway-dev', undefined], ['deploy-aws-lambda-dev', 'UPDATE_COMPLETE'],
    ['deploy-aws-api-gateway-prod', undefined], ['deploy-aws-lambda-prod', undefined],
  ]);
});

test('marks the archived template the stack runs now', async () => {
  const details = (await getStackDetails(fakeCfn(), fakeDynamo(), PROJECT, STACK))!;
  assert.ok(details.runningArchived);
  assert.deepEqual(details.templates.map((t) => [t.deployedAt, t.running, t.stable, t.rolledBack]), [
    ['2026-10-09T12:00:00.000Z', true, false, false],
    ['2026-10-09T11:00:00.000Z', false, false, true],
    ['2026-10-09T10:00:00.000Z', false, true, false],
  ]);
  assert.equal(details.templates[0].runUrl, 'https://github.com/o/r/actions/runs/1');
  assert.equal(details.templates[2].runUrl, undefined, 'a run URL built without GitHub variables is left out');
  assert.deepEqual(details.outputs, [{ key: 'FunctionName', value: 'service-lambda-dev' }]);
  assert.equal(await getStackDetails(fakeCfn(), fakeDynamo(), PROJECT, 'deploy-aws-lambda-prod'), undefined);
});

test('starts a restore in the environment\'s rollback service', async () => {
  const lambda = fakeLambda();
  const outcome = await restoreStackTemplate(fakeCfn(), fakeDynamo(), lambda.client, PROJECT, STACK, {
    deployedAt: '2026-10-09T10:00:00.000Z', actor: 'dashboard:a@b.c', reason: 'bad alarm',
  });
  assert.ok(outcome.ok);
  assert.equal(parseOperationId(outcome.operationId)?.kind, 'cloudformation-restore');
  assert.equal(lambda.sent[0].FunctionName, 'rollback-factory-demo-rollback-service-dev');
  assert.equal(lambda.sent[0].InvocationType, 'Event');
  const payload = JSON.parse(new TextDecoder().decode(lambda.sent[0].Payload));
  assert.deepEqual({ ...payload, operationId: undefined }, {
    type: 'restore', manager: 'cloudformation', stackName: STACK, deployedAt: '2026-10-09T10:00:00.000Z',
    actor: 'dashboard:a@b.c', reason: 'bad alarm', operationId: undefined,
  });
});

test('refuses the running template, an unknown record and a stack mid-update', async () => {
  const lambda = fakeLambda();
  const restore = (deployedAt: string, status?: string) =>
    restoreStackTemplate(fakeCfn(status), fakeDynamo(), lambda.client, PROJECT, STACK, { deployedAt });
  assert.deepEqual(await restore('2026-10-09T12:00:00.000Z'), {
    ok: false, status: 409, message: `${STACK} already runs the template archived at 2026-10-09T12:00:00.000Z`,
  });
  assert.equal(((await restore('2026-01-01T00:00:00.000Z')) as any).status, 404);
  assert.equal(((await restore('2026-10-09T10:00:00.000Z', 'UPDATE_IN_PROGRESS')) as any).status, 409);
  assert.equal(lambda.sent.length, 0);
});
