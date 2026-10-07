// The Lambda functions registered for rollback (rollback-service/rollback-config.json), which the
// dashboard's alias/version menus may change through the rollback service. The stack passes them in
// REGISTERED_FUNCTIONS as [{ "name": "service-lambda-<env>", "alias": "live" }]; any other function is
// read-only on the dashboard.

export interface RegisteredFunction {
  /** with the <env> placeholder, e.g. service-lambda-<env> */
  name: string;
  /** the alias the rollback service watches and rolls back (moving it restores $LATEST too) */
  alias: string;
}

/** What a function name resolves to: its environment's rollback service and its watched alias. */
export interface Registration {
  rollbackService: string;
  alias: string;
  /** the rollback service's version archive of that environment: which versions are in S3, which are stable */
  archiveTable: string;
}

export function parseRegistered(json: string | undefined): RegisteredFunction[] {
  if (!json) return [];
  const parsed = JSON.parse(json) as RegisteredFunction[];
  return parsed.filter((fn) => typeof fn.name === 'string' && fn.name.includes('<env>') && typeof fn.alias === 'string');
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The registration of `functionName`, or undefined when it isn't registered in any environment. */
export function registrationFor(functionName: string, registered: RegisteredFunction[], project: string): Registration | undefined {
  for (const fn of registered) {
    const [before, after] = fn.name.split('<env>');
    const env = new RegExp(`^${escape(before)}([a-z0-9]+)${escape(after)}$`).exec(functionName)?.[1];
    if (env) return { rollbackService: `${project}-rollback-service-${env}`, alias: fn.alias, archiveTable: `${project}-lambda-archive-${env}` };
  }
  return undefined;
}
