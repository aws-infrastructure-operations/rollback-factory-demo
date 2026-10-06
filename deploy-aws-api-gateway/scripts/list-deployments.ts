/**
 * Shows the most recent recorded deployments of an environment.
 *
 * Usage: npx tsx scripts/list-deployments.ts --env dev [--limit 10]
 */
import { DeploymentRecord, formatDuration, listDeployments } from '../lambda/shared/deployments.js';
import { parseCli, run } from './lib/cli.js';
import { deploymentTarget, requireStackOutputs } from './lib/stack.js';

const stability = (r: DeploymentRecord) => {
  if (r.stable === undefined) return '';
  if (!r.stable) return 'unstable';
  // older records only have stableFor (seconds)
  const stableFor = r.stableForHumanReadable ?? (r.stableFor === undefined ? '' : formatDuration(r.stableFor));
  return `stable ${stableFor}`.trim();
};

run(async () => {
  const { config, values } = parseCli(['limit'] as const);
  const target = deploymentTarget(config, await requireStackOutputs(config));
  const records = await listDeployments(target.table, target.apiName, Number(values.limit ?? 10));

  console.table(records.map((r) => ({
    deployedAt: r.deployedAt,
    deploymentId: r.deploymentId,
    source: r.source,
    current: r.current ? 'yes' : '',
    stability: stability(r),
    actor: r.actor,
    verified: r.verifiedAt ? 'yes' : '',
    rolledBack: r.rolledBackAt ? 'yes' : '',
    commit: r.commitSha?.slice(0, 7) ?? '',
    spec: r.specKey,
  })));
});
