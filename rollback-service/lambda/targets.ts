// Rollback targets: each project stack publishes what its rollback manager needs as one JSON
// stack output, RollbackTarget. Reading it here (instead of duplicating names and ids in this
// service) keeps the service in step with the projects, e.g. a new REST API id after a redeploy.
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const ROLLBACK_TARGET_OUTPUT = 'RollbackTarget';

export function createTargetReader(cfn: Pick<CloudFormationClient, 'send'> = new CloudFormationClient({})) {
  const cache = new Map<string, Promise<unknown>>();

  async function read(stackName: string) {
    const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const output = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === ROLLBACK_TARGET_OUTPUT)?.OutputValue;
    if (!output) throw new Error(`Stack ${stackName} has no ${ROLLBACK_TARGET_OUTPUT} output`);
    return JSON.parse(output);
  }

  return {
    /** The parsed RollbackTarget of a stack, read once per invocation (see clear()). */
    get<T>(stackName: string): Promise<T> {
      if (!cache.has(stackName)) cache.set(stackName, read(stackName));
      return cache.get(stackName) as Promise<T>;
    },
    /** Called at the start of every invocation: a redeploy may have changed the outputs. */
    clear() {
      cache.clear();
    },
  };
}

export type TargetReader = ReturnType<typeof createTargetReader>;
