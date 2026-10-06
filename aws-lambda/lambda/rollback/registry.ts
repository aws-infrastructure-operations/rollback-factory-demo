// Functions registered for automatic rollback (rollback-config.json), resolved for one environment.
// Shared by the stack (permissions, alarm access) and the rollback function (pre-hook, guards).

export interface RollbackConfigFile {
  maxConsecutiveRollbacks?: number;
  deploymentWindowMinutes?: number;
  functions?: Array<{
    name: string;
    enabled?: boolean;
    alias?: string;
    alarms?: string[];
    maxConsecutiveRollbacks?: number;
    deploymentWindowMinutes?: number;
  }>;
}

export interface Registration {
  name: string;
  alias: string;
  alarms: Set<string>;
  /** Automatic rollbacks in a row before giving up; the count resets on the next deploy. */
  maxConsecutiveRollbacks: number;
  /** Automatic rollback only within this many minutes of the last deploy or rollback. */
  deploymentWindowMinutes: number;
}

export const DEFAULT_ALIAS = 'live';
const DEFAULT_MAX_CONSECUTIVE_ROLLBACKS = 2;
const DEFAULT_DEPLOYMENT_WINDOW_MINUTES = 10;

/**
 * Enabled functions by name, with `<env>` in names and alarm names replaced. Deregister a function
 * by removing it or setting "enabled": false.
 */
export function resolveRegistry(file: RollbackConfigFile, envName: string): Map<string, Registration> {
  const env = (name: string) => name.replaceAll('<env>', envName);
  const maxConsecutiveRollbacks = file.maxConsecutiveRollbacks ?? DEFAULT_MAX_CONSECUTIVE_ROLLBACKS;
  const deploymentWindowMinutes = file.deploymentWindowMinutes ?? DEFAULT_DEPLOYMENT_WINDOW_MINUTES;
  return new Map((file.functions ?? [])
    .filter((fn) => fn.enabled !== false)
    .map((fn) => [env(fn.name), {
      name: env(fn.name),
      alias: fn.alias ?? DEFAULT_ALIAS,
      alarms: new Set((fn.alarms ?? []).map(env)),
      maxConsecutiveRollbacks: fn.maxConsecutiveRollbacks ?? maxConsecutiveRollbacks,
      deploymentWindowMinutes: fn.deploymentWindowMinutes ?? deploymentWindowMinutes,
    }]));
}
