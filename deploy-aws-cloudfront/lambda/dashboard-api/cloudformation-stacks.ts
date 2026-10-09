// The CloudFormation stacks whose templates .github/workflows/deploy-test-rollback.yml archives:
// deploy-aws-api-gateway-<env> and deploy-aws-lambda-<env>, dev and prod. Each deployed template is
// in the environment's stack-templates bucket, with a record in <project>-stack-templates-<env>.
// Restoring one goes through that environment's rollback service (its CloudFormation manager), which
// updates the stack to the template and waits for the update.
import { createHash } from 'node:crypto';
import {
  DescribeStacksCommand, GetTemplateCommand, type CloudFormationClient, type Stack,
} from '@aws-sdk/client-cloudformation';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { startOperation } from './operations.js';

export const STACK_ENVS = ['dev', 'prod'] as const;
export const STACK_PROJECTS = ['api-gateway', 'lambda'] as const;
/** deploy-aws-api-gateway-dev, deploy-aws-lambda-dev, ... prod */
export const restorableStacks = () => STACK_ENVS.flatMap((env) => STACK_PROJECTS.map((p) => `deploy-aws-${p}-${env}`));
const envOf = (stackName: string) => /^deploy-aws-(?:api-gateway|lambda)-(dev|prod)$/.exec(stackName)?.[1];
export const isRestorableStack = (value: unknown): value is string => typeof value === 'string' && envOf(value) !== undefined;

export const stackTemplatesTableFor = (stackName: string, project: string) => `${project}-stack-templates-${envOf(stackName)}`;
export const rollbackServiceForStack = (stackName: string, project: string) => `${project}-rollback-service-${envOf(stackName)}`;

/** The parts of a record (rollback-service managers/cloudformation/manager.ts) the dashboard reads. */
interface StackTemplateRecord {
  stackName: string;
  deployedAt: string;
  templateBucket: string;
  templateKey: string;
  templateSha256: string;
  source: string;
  actor?: string;
  commitSha?: string;
  runUrl?: string;
  description?: string;
  stable?: boolean;
  verifiedAt?: string;
  rolledBackAt?: string;
  restoredFrom?: string;
}

/** One archived template, as GET /api/cloudformation-stacks/<name> returns it (app/src/api.ts has the same shape). */
export interface ArchivedTemplate {
  /** ISO 8601, the record's key: what a restore names */
  deployedAt: string;
  /** baseline | cicd | rollback | restore */
  source: string;
  actor?: string;
  commit?: string;
  runUrl?: string;
  description?: string;
  /** s3://<bucket>/<stack>/<timestamp>/template.json */
  template: string;
  /** the first 12 characters of its sha256 */
  templateHash: string;
  /** the stack runs this template now */
  running: boolean;
  /** the integration tests passed on it */
  stable: boolean;
  rolledBack: boolean;
  restoredFrom?: string;
}

/** One stack in the list (GET /api/cloudformation-stacks). */
export interface StackSummary {
  name: string;
  env: string;
  /** api-gateway | lambda */
  project: string;
  /** absent when the stack doesn't exist */
  status?: string;
  lastUpdated?: string;
}

export interface StackDetails extends StackSummary {
  statusReason?: string;
  /** what the stack runs is one of the archived templates; false when another workflow deployed it since */
  runningArchived: boolean;
  /** newest first, the latest 25 */
  templates: ArchivedTemplate[];
  configuration: Array<{ label: string; value: string }>;
  outputs: Array<{ key: string; value: string; description?: string }>;
}

export const MAX_ARCHIVED_TEMPLATES = 25;

/** A stack in one of these states can be updated, so restored. */
export const isUpdatable = (status?: string) =>
  /^(CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE|IMPORT_ROLLBACK_COMPLETE)$/.test(status ?? '');

/** deployedAt values are toISOString() output. */
const isDeployedAt = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value);

/** JSON with every object's keys sorted, compact: what `jq -cS` prints. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The hash the archive records for a template: sha256 of the compact, key-sorted JSON plus the newline
 * jq ends it with (.github/scripts/stack-templates.sh). Undefined for a template that isn't JSON.
 */
export function templateSha256(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return createHash('sha256').update(`${sortedJson(parsed)}\n`).digest('hex');
}

async function describe(cfn: CloudFormationClient, stackName: string): Promise<Stack | undefined> {
  try {
    return (await cfn.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
  } catch (err) {
    if (/does not exist/.test((err as Error).message ?? '')) return undefined;
    throw err;
  }
}

/** Undefined when the table doesn't exist (that environment's rollback service isn't deployed). */
async function records(dynamo: DynamoDBDocumentClient, project: string, stackName: string) {
  try {
    const { Items = [] } = await dynamo.send(new QueryCommand({
      TableName: stackTemplatesTableFor(stackName, project),
      KeyConditionExpression: 'stackName = :s',
      ExpressionAttributeValues: { ':s': stackName },
      ScanIndexForward: false,
      Limit: MAX_ARCHIVED_TEMPLATES,
    }));
    return Items as StackTemplateRecord[];
  } catch (err) {
    if ((err as Error).name === 'ResourceNotFoundException') return undefined;
    throw err;
  }
}

/** The template the stack runs now, hashed like the archive does. */
async function runningSha(cfn: CloudFormationClient, stackName: string) {
  const { TemplateBody } = await cfn.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: 'Original' }));
  return TemplateBody ? templateSha256(TemplateBody) : undefined;
}

const summary = (stackName: string, stack?: Stack): StackSummary => ({
  name: stackName,
  env: envOf(stackName)!,
  project: /^deploy-aws-(api-gateway|lambda)-/.exec(stackName)![1],
  ...(stack?.StackStatus && { status: stack.StackStatus }),
  ...((stack?.LastUpdatedTime ?? stack?.CreationTime) && { lastUpdated: (stack!.LastUpdatedTime ?? stack!.CreationTime)!.toISOString() }),
});

export async function listStacks(cfn: CloudFormationClient): Promise<StackSummary[]> {
  return Promise.all(restorableStacks().map(async (name) => summary(name, await describe(cfn, name))));
}

/** Undefined when the stack doesn't exist. */
export async function getStackDetails(
  cfn: CloudFormationClient,
  dynamo: DynamoDBDocumentClient,
  project: string,
  stackName: string,
): Promise<StackDetails | undefined> {
  const stack = await describe(cfn, stackName);
  if (!stack) return undefined;
  const [archived, sha] = await Promise.all([records(dynamo, project, stackName), runningSha(cfn, stackName)]);
  // the newest record with the running template is the one it runs (a restore repeats an older one)
  const runningAt = (archived ?? []).find((r) => r.templateSha256 === sha)?.deployedAt;
  const templates = (archived ?? []).map((r): ArchivedTemplate => ({
    deployedAt: r.deployedAt,
    source: r.source,
    ...(r.actor && { actor: r.actor }),
    ...(r.commitSha && { commit: r.commitSha }),
    ...(r.runUrl && !r.runUrl.endsWith('/runs/') && { runUrl: r.runUrl }),
    ...(r.description && { description: r.description }),
    template: `s3://${r.templateBucket}/${r.templateKey}`,
    templateHash: r.templateSha256.slice(0, 12),
    running: r.deployedAt === runningAt,
    stable: r.stable === true,
    rolledBack: r.rolledBackAt !== undefined,
    ...(r.restoredFrom && { restoredFrom: r.restoredFrom }),
  }));
  const configuration: Array<[string, string | undefined]> = [
    ['Status', stack.StackStatus],
    ['Status reason', stack.StackStatusReason],
    ['Created', stack.CreationTime?.toISOString()],
    ['Last updated', stack.LastUpdatedTime?.toISOString()],
    ['Service role', stack.RoleARN],
    ['Running template hash', sha?.slice(0, 12)],
    ['Template archive', archived ? stackTemplatesTableFor(stackName, project) : 'not deployed (rollback-service)'],
    ['Termination protection', stack.EnableTerminationProtection ? 'on' : 'off'],
  ];
  return {
    ...summary(stackName, stack),
    ...(stack.StackStatusReason && { statusReason: stack.StackStatusReason }),
    runningArchived: runningAt !== undefined,
    templates,
    configuration: configuration.filter((c): c is [string, string] => c[1] !== undefined).map(([label, value]) => ({ label, value })),
    outputs: (stack.Outputs ?? []).map((o) => ({ key: o.OutputKey ?? '', value: o.OutputValue ?? '', ...(o.Description && { description: o.Description }) })),
  };
}

export type StackRestoreResult =
  | { ok: true; operationId: string }
  | { ok: false; status: 400 | 404 | 409; message: string };

/**
 * Puts the stack back on the template archived at `deployedAt`: the environment's rollback service
 * updates the stack to it and waits for CloudFormation, while the page follows the run.
 */
export async function restoreStackTemplate(
  cfn: CloudFormationClient,
  dynamo: DynamoDBDocumentClient,
  lambda: LambdaClient,
  project: string,
  stackName: string,
  req: { deployedAt: string; reason?: string; actor?: string },
): Promise<StackRestoreResult> {
  if (!isRestorableStack(stackName)) return { ok: false, status: 400, message: `${stackName} isn't a stack whose templates are archived` };
  if (!isDeployedAt(req.deployedAt)) return { ok: false, status: 400, message: 'Expected deployedAt as ISO 8601' };
  const stack = await describe(cfn, stackName);
  if (!stack) return { ok: false, status: 404, message: `No stack ${stackName}` };
  const record = (await records(dynamo, project, stackName))?.find((r) => r.deployedAt === req.deployedAt);
  if (!record) return { ok: false, status: 404, message: `No template of ${stackName} archived at ${req.deployedAt}` };
  if (!isUpdatable(stack.StackStatus)) return { ok: false, status: 409, message: `${stackName} is ${stack.StackStatus}: wait until that is over` };
  if (record.templateSha256 === await runningSha(cfn, stackName)) {
    return { ok: false, status: 409, message: `${stackName} already runs the template archived at ${req.deployedAt}` };
  }
  const operationId = await startOperation(lambda, rollbackServiceForStack(stackName, project), 'cloudformation-restore', {
    type: 'restore', manager: 'cloudformation', stackName, deployedAt: record.deployedAt, actor: req.actor ?? 'dashboard', reason: req.reason,
  });
  return { ok: true, operationId };
}
