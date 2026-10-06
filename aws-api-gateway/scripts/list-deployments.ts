/**
 * Shows the most recent recorded deployments of an environment.
 *
 * Usage: npx tsx scripts/list-deployments.ts --env dev [--limit 10]
 */
import { listDeployments } from '../lambda/shared/deployments.js';
import { parseCli, run } from './lib/cli.js';
import { deploymentTarget, requireStackOutputs } from './lib/stack.js';

run(async () => {
  const { config, values } = parseCli(['limit'] as const);
  const target = deploymentTarget(config, await requireStackOutputs(config));
  const records = await listDeployments(target.table, target.apiName, Number(values.limit ?? 10));

  console.table(records.map((r) => ({
    deployedAt: r.deployedAt,
    deploymentId: r.deploymentId,
    source: r.source,
    actor: r.actor,
    commit: r.commitSha?.slice(0, 7) ?? '',
    spec: r.specKey,
  })));
});
