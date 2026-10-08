// Pointing an alias of a registered function at a version (the Lambda panel's menus). The rollback
// service of the function's environment does it, so the version archive stays right: moving the
// watched alias (live) restores $LATEST and is recorded as a manual rollback or a promotion.
import type { LambdaClient } from '@aws-sdk/client-lambda';
import { registrationFor, type RegisteredFunction } from './registered-functions.js';
import { startOperation } from './operations.js';

export type PointAliasResult =
  | { ok: true; operationId: string }
  | { ok: false; status: 400; message: string };

/** Alias names: letters, digits, '-' and '_' (Lambda allows a leading letter or digit). */
export const isAliasName = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name);

/** Published versions: positive integers (not $LATEST). */
export const isVersion = (version: unknown): version is number => Number.isInteger(version) && (version as number) >= 1;

export async function pointAlias(
  lambda: LambdaClient,
  registered: RegisteredFunction[],
  project: string,
  functionName: string,
  /** actor: who asked, dashboard:<email> (default dashboard) */
  req: { aliasName: string; version: number; actor?: string },
): Promise<PointAliasResult> {
  const registration = registrationFor(functionName, registered, project);
  if (!registration) {
    return { ok: false, status: 400, message: `${functionName} isn't registered for rollback (rollback-config.json): its aliases can't be changed here` };
  }
  // the page follows the run in a popup (GET /api/operations/<id>)
  const operationId = await startOperation(lambda, registration.rollbackService, 'lambda-point-alias', { type: 'point-alias', functionName, aliasName: req.aliasName, version: req.version, actor: req.actor ?? 'dashboard' });
  return { ok: true, operationId };
}
