/**
 * Shows the most recent recorded deployments of an environment.
 *
 * Usage: npx tsx scripts/list-deployments.ts --env dev [--limit 10]
 */
import { DeploymentRecord, listDeployments } from '../lambda/shared/deployments.js';
import { parseCli, run } from './lib/cli.js';
import { deploymentTarget, requireStackOutputs } from './lib/stack.js';

/** 9006 -> 2h 30m 6s */
const duration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h && `${h}h`, (h || m) && `${m}m`, `${s}s`].filter(Boolean).join(' ');
};

const stability = (r: DeploymentRecord) => {
  if (r.stable === undefined) return '';
  return r.stable ? `stable ${r.stableFor === undefined ? '' : duration(r.stableFor)}`.trim() : 'unstable';
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
