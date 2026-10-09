import type { DeploymentRecord } from '../../lambda/shared/deployments.js';

/**
 * The newest deployment recorded before `before` that is stable: it passed the integration tests
 * (verifiedAt), was never rolled back (rolledBackAt) and was replaced by a newer deployment without an
 * alarm (stable is set when it is retired; false once rolled back). Records come newest first, as
 * listDeployments returns them. Records from before `stable` existed count when verified and retired.
 */
export function latestStable(records: DeploymentRecord[], before: string): DeploymentRecord | undefined {
  return records.find((r) => r.deployedAt < before
    && r.verifiedAt
    && !r.rolledBackAt
    && r.stable !== false
    && r.current !== true);
}
