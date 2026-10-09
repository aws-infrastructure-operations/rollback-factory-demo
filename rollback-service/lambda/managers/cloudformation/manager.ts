/**
 * CloudFormation restore manager. Puts a project stack back on a template it ran before: every
 * template .github/workflows/deploy-test-rollback.yml deploys is archived in S3 and recorded in the
 * stack-templates table (stackName + deployedAt). The dashboard picks a record; this updates the
 * stack to that template (with the stack's own CloudFormation service role, the CDK execution role),
 * waits for the update and records a "restore". No alarm triggers it: restores are chosen by hand.
 *
 * The restore is not stable until the integration tests pass on it again (deploy-test-rollback.yml).
 */
import { createHash } from 'node:crypto';
import {
  CloudFormationClient, DescribeStacksCommand, GetTemplateCommand, UpdateStackCommand, type Stack,
} from '@aws-sdk/client-cloudformation';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

/** One item of the stack-templates table (written by .github/scripts/stack-templates.sh and here). */
export interface StackTemplateRecord {
  stackName: string;
  /** ISO 8601, the sort key */
  deployedAt: string;
  templateBucket: string;
  /** <stack>/<timestamp>/template.json */
  templateKey: string;
  /** sha256 of the template as compact JSON with sorted keys (and a newline, as jq -cS writes it) */
  templateSha256: string;
  /** JSON array of the stack's parameter names when it was archived */
  parameterKeys: string;
  /** baseline | cicd | rollback | restore */
  source: string;
  actor?: string;
  commitSha?: string;
  runUrl?: string;
  description?: string;
  /** the integration tests passed on it */
  stable?: boolean;
  verifiedAt?: string;
  rolledBackAt?: string;
  rolledBackFrom?: string;
  /** for restores: the deployedAt of the record whose template was restored */
  restoredFrom?: string;
  /** for restores: the hash of the template the stack ran before (it may never have been archived) */
  replacedTemplateSha256?: string;
}

export interface StackRestoreRequest {
  stackName: string;
  deployedAt: string;
  reason?: string;
  actor?: string;
}

export interface CloudFormationDeps {
  cfn: CloudFormationClient;
  ddb: DynamoDBDocumentClient;
  /** rollback-factory-demo-stack-templates-<env> */
  table: string;
  region: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** how often to check the update, and for how long (the Lambda's timeout is 10 minutes) */
  pollMs?: number;
  maxWaitMs?: number;
}

/** The stacks deploy-test-rollback.yml archives, and so the only ones this restores. */
export const restorableStacks = (env: string) => [`deploy-aws-api-gateway-${env}`, `deploy-aws-lambda-${env}`];

/** A stack in one of these states can be updated. */
const UPDATABLE = /^(CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE|IMPORT_ROLLBACK_COMPLETE)$/;

const log = (msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ manager: 'cloudformation', msg, ...data }));

/** JSON with every object's keys sorted, compact: what `jq -cS` prints. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A template's hash as the archive records it: sha256 of the compact, key-sorted JSON plus jq's
 * newline (.github/scripts/stack-templates.sh). Undefined for a template that isn't JSON.
 */
export function templateSha256(body: string): string | undefined {
  try {
    return createHash('sha256').update(`${sortedJson(JSON.parse(body))}\n`).digest('hex');
  } catch {
    return undefined;
  }
}

async function describe(cfn: CloudFormationClient, stackName: string): Promise<Stack> {
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  if (!Stacks?.[0]) throw new Error(`Stack ${stackName} not found`);
  return Stacks[0];
}

export async function restore(deps: CloudFormationDeps, env: string, req: StackRestoreRequest) {
  const { cfn, ddb, table } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const pollMs = deps.pollMs ?? 10_000;
  const maxWaitMs = deps.maxWaitMs ?? 9 * 60_000;

  if (!restorableStacks(env).includes(req.stackName)) {
    throw new Error(`${req.stackName} is not a stack the ${env} rollback service restores (${restorableStacks(env).join(', ')})`);
  }
  const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: { stackName: req.stackName, deployedAt: req.deployedAt } }));
  const to = Item as StackTemplateRecord | undefined;
  if (!to) throw new Error(`No template of ${req.stackName} archived at ${req.deployedAt}`);
  log('restoring', { stackName: req.stackName, to: to.deployedAt, template: `s3://${to.templateBucket}/${to.templateKey}`, actor: req.actor });

  const stack = await describe(cfn, req.stackName);
  if (!UPDATABLE.test(stack.StackStatus ?? '')) {
    throw new Error(`${req.stackName} is ${stack.StackStatus}: it can only be restored once that is over`);
  }
  // the CDK execution role CloudFormation already uses for this stack: it may change the stack's
  // resources, this function may not
  if (!stack.RoleARN) throw new Error(`${req.stackName} has no CloudFormation service role, so it can't be updated from here`);
  // keep the current value of each parameter the old template has too (CDK's BootstrapVersion)
  const current = new Set((stack.Parameters ?? []).map((p) => p.ParameterKey));
  const parameters = (JSON.parse(to.parameterKeys || '[]') as string[])
    .filter((key) => current.has(key))
    .map((ParameterKey) => ({ ParameterKey, UsePreviousValue: true }));

  // what the stack runs now, so the restore records what it replaced
  const { TemplateBody } = await cfn.send(new GetTemplateCommand({ StackName: req.stackName, TemplateStage: 'Original' }));
  const replaced = TemplateBody ? templateSha256(TemplateBody) : undefined;

  const startedAt = now();
  try {
    await cfn.send(new UpdateStackCommand({
      StackName: req.stackName,
      TemplateURL: `https://${to.templateBucket}.s3.${deps.region}.amazonaws.com/${to.templateKey}`,
      Parameters: parameters,
      Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
      RoleARN: stack.RoleARN,
    }));
  } catch (err) {
    if ((err as Error).message?.includes('No updates are to be performed')) {
      return { action: 'skip', reason: `${req.stackName} already runs the template archived at ${to.deployedAt}` };
    }
    throw err;
  }
  log('update started', { step: 'update-started', stackName: req.stackName, from: stack.StackStatus });

  let status = 'UPDATE_IN_PROGRESS';
  let reason: string | undefined;
  while (status.endsWith('_IN_PROGRESS')) {
    if (now().getTime() - startedAt.getTime() > maxWaitMs) {
      throw new Error(`${req.stackName} is still ${status} after ${Math.round(maxWaitMs / 60_000)} minutes: follow it in the CloudFormation console`);
    }
    await sleep(pollMs);
    const latest = await describe(cfn, req.stackName);
    if (latest.StackStatus !== status) log('stack status', { stackName: req.stackName, status: latest.StackStatus });
    status = latest.StackStatus ?? 'UNKNOWN';
    reason = latest.StackStatusReason;
  }
  if (status !== 'UPDATE_COMPLETE') {
    // CloudFormation rolled the update back itself: the stack still runs what it ran before
    throw new Error(`Updating ${req.stackName} ended in ${status}${reason ? `: ${reason}` : ''}`);
  }
  log('stack updated', { step: 'stack-updated', stackName: req.stackName, seconds: Math.round((now().getTime() - startedAt.getTime()) / 1000) });

  // Not stable: it has to pass the integration tests again (like the API's restores).
  const description = `Restore to the template archived at ${to.deployedAt}${req.reason ? `: ${req.reason}` : ''}`;
  const record: StackTemplateRecord = {
    stackName: req.stackName,
    deployedAt: now().toISOString(),
    templateBucket: to.templateBucket,
    templateKey: to.templateKey,
    templateSha256: to.templateSha256,
    parameterKeys: to.parameterKeys,
    source: 'restore',
    actor: req.actor ?? 'manual',
    ...(to.commitSha && { commitSha: to.commitSha }),
    description,
    stable: false,
    restoredFrom: to.deployedAt,
    ...(replaced && { replacedTemplateSha256: replaced }),
  };
  await ddb.send(new PutCommand({ TableName: table, Item: record, ConditionExpression: 'attribute_not_exists(deployedAt)' }));
  log('restore complete', { stackName: req.stackName, to: to.deployedAt, deployedAt: record.deployedAt });
  return { action: 'restored', stackName: req.stackName, to: to.deployedAt, deployedAt: record.deployedAt };
}
