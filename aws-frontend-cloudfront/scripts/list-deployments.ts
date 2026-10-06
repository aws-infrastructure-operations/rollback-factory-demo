/**
 * Shows the most recent recorded deployments of an environment.
 *
 * Usage: npx tsx scripts/list-deployments.ts --env dev [--limit 10]
 */
import { DeploymentRecord } from '../lambda/shared/deployments.js';
import { parseCli, run } from './lib/cli.js';
import { deploymentStore, requireFrontendOutputs } from './lib/stack.js';

const stability = (r: DeploymentRecord) => {
  if (r.stable === undefined) return '';
  return r.stable ? `stable ${r.stableForHumanReadable ?? ''}`.trim() : 'unstable';
};

run(async () => {
  const { config, values } = parseCli(['limit']);
  const store = deploymentStore(config, await requireFrontendOutputs(config));
  const records = await store.list(Number(values.limit ?? 10));

  console.table(records.map((r) => ({
    deployedAt: r.deployedAt,
    release: r.releaseId,
    source: r.source,
    current: r.current ? 'yes' : '',
    stability: stability(r),
    verified: r.verifiedAt ? 'yes' : '',
    rolledBack: r.rolledBackAt ? 'yes' : '',
    previous: r.previousReleaseId ?? '',
    actor: r.actor,
    commit: r.commit?.slice(0, 7) ?? '',
  })));
});
