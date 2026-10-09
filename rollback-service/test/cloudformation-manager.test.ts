// CloudFormation restore manager, with CloudFormation and DynamoDB stubbed.
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { CloudFormationClient, DescribeStacksCommand, GetTemplateCommand, UpdateStackCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import {
  restore, templateSha256, type CloudFormationDeps, type StackTemplateRecord,
} from '../lambda/managers/cloudformation/manager.js';

const STACK = 'deploy-aws-lambda-dev';
const ROLE = 'arn:aws:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-123456789012-eu-central-1';
const GOOD: StackTemplateRecord = {
  stackName: STACK,
  deployedAt: '2026-10-09T10:00:00.000Z',
  templateBucket: 'rollback-factory-demo-123456789012-stack-templates-dev',
  templateKey: `${STACK}/20261009T100000Z/template.json`,
  templateSha256: 'abc',
  parameterKeys: '["BootstrapVersion","Removed"]',
  source: 'cicd',
  commitSha: 'deadbeef',
  stable: true,
};

let statuses: string[];
let updateError: Error | undefined;
let calls: any[];

beforeEach(() => {
  // what DescribeStacks answers, in turn: before the update, then while polling
  statuses = ['UPDATE_COMPLETE', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', 'UPDATE_COMPLETE'];
  updateError = undefined;
  calls = [];
});

const deps = (): CloudFormationDeps => ({
  cfn: {
    send: async (command: any) => {
      calls.push(command);
      if (command instanceof DescribeStacksCommand) {
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
        return { Stacks: [{ StackName: STACK, StackStatus: status, RoleARN: ROLE, Parameters: [{ ParameterKey: 'BootstrapVersion' }] }] };
      }
      // the template it runs now, pretty-printed like CDK writes it
      if (command instanceof GetTemplateCommand) return { TemplateBody: JSON.stringify({ Resources: { b: 1, a: [2] } }, null, 1) };
      if (command instanceof UpdateStackCommand) {
        if (updateError) throw updateError;
        return { StackId: 'id' };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  } as unknown as CloudFormationClient,
  ddb: {
    send: async (command: any) => {
      calls.push(command);
      if (command instanceof GetCommand) return { Item: command.input.Key?.deployedAt === GOOD.deployedAt ? GOOD : undefined };
      if (command instanceof PutCommand) return {};
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  } as unknown as DynamoDBDocumentClient,
  table: 'rollback-factory-demo-stack-templates-dev',
  region: 'eu-central-1',
  sleep: async () => {},
  now: () => new Date('2026-10-09T12:00:00.000Z'),
});

const sent = <T>(type: new (...args: any[]) => T) => calls.filter((c) => c instanceof type) as any[];

test('updates the stack to the archived template with its own role, waits, and records an unverified restore', async () => {
  const result = await restore(deps(), 'dev', { stackName: STACK, deployedAt: GOOD.deployedAt, actor: 'dashboard:a@b.c', reason: 'bad alarm' });
  assert.deepEqual(result, { action: 'restored', stackName: STACK, to: GOOD.deployedAt, deployedAt: '2026-10-09T12:00:00.000Z' });

  const [update] = sent(UpdateStackCommand);
  assert.equal(update.input.TemplateURL, `https://${GOOD.templateBucket}.s3.eu-central-1.amazonaws.com/${GOOD.templateKey}`);
  assert.equal(update.input.RoleARN, ROLE);
  // only the parameters the stack still has keep their value
  assert.deepEqual(update.input.Parameters, [{ ParameterKey: 'BootstrapVersion', UsePreviousValue: true }]);
  assert.equal(sent(DescribeStacksCommand).length, 4, 'polled until UPDATE_COMPLETE');

  const [put] = sent(PutCommand);
  assert.deepEqual(put.input.Item, {
    stackName: STACK,
    deployedAt: '2026-10-09T12:00:00.000Z',
    templateBucket: GOOD.templateBucket,
    templateKey: GOOD.templateKey,
    templateSha256: 'abc',
    parameterKeys: GOOD.parameterKeys,
    source: 'restore',
    actor: 'dashboard:a@b.c',
    commitSha: 'deadbeef',
    description: `Restore to the template archived at ${GOOD.deployedAt}: bad alarm`,
    stable: false,
    restoredFrom: GOOD.deployedAt,
    replacedTemplateSha256: createHash('sha256').update('{"Resources":{"a":[2],"b":1}}\n').digest('hex'),
  });
});

test('hashes a template like jq -cS: compact, keys sorted, with a newline; not YAML', () => {
  assert.equal(templateSha256('{ "b": {"d": 1, "c": [true, null]}, "a": "é" }'),
    createHash('sha256').update('{"a":"é","b":{"c":[true,null],"d":1}}\n').digest('hex'));
  assert.equal(templateSha256('Resources: {}'), undefined);
});

test('only restores the stacks deploy-test-rollback archives, of its own environment', async () => {
  for (const stackName of ['deploy-aws-lambda-prod', 'rollback-service-dev', 'deploy-aws-cloudfront-dev']) {
    await assert.rejects(restore(deps(), 'dev', { stackName, deployedAt: GOOD.deployedAt }), /is not a stack the dev rollback service restores/);
  }
  assert.equal(calls.length, 0);
});

test('refuses an unknown record or a stack that is mid-update', async () => {
  await assert.rejects(restore(deps(), 'dev', { stackName: STACK, deployedAt: '2026-01-01T00:00:00.000Z' }), /No template/);
  statuses = ['UPDATE_IN_PROGRESS'];
  await assert.rejects(restore(deps(), 'dev', { stackName: STACK, deployedAt: GOOD.deployedAt }), /is UPDATE_IN_PROGRESS/);
  assert.equal(sent(UpdateStackCommand).length, 0);
});

test('skips when the stack already runs that template', async () => {
  updateError = new Error('No updates are to be performed.');
  const result = await restore(deps(), 'dev', { stackName: STACK, deployedAt: GOOD.deployedAt });
  assert.equal(result.action, 'skip');
  assert.equal(sent(PutCommand).length, 0);
});

test('fails, recording nothing, when CloudFormation rolls the update back', async () => {
  statuses = ['UPDATE_COMPLETE', 'UPDATE_IN_PROGRESS', 'UPDATE_ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_COMPLETE'];
  await assert.rejects(restore(deps(), 'dev', { stackName: STACK, deployedAt: GOOD.deployedAt }), /ended in UPDATE_ROLLBACK_COMPLETE/);
  assert.equal(sent(PutCommand).length, 0);
});
