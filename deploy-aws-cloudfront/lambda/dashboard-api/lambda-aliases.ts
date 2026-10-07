// Pointing an alias of a registered function at a version (the Lambda panel's menus). The rollback
// service of the function's environment does it, so the version archive stays right: moving the
// watched alias (live) restores $LATEST and is recorded as a manual rollback or a promotion.
import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import { registrationFor, type RegisteredFunction } from './registered-functions.js';

export type PointAliasResult =
  | { ok: true; result: unknown }
  | { ok: false; status: 400 | 409 | 502; message: string };

/** Alias names: letters, digits, '-' and '_' (Lambda allows a leading letter or digit). */
export const isAliasName = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name);

/** Published versions: positive integers (not $LATEST). */
export const isVersion = (version: unknown): version is number => Number.isInteger(version) && (version as number) >= 1;

export async function pointAlias(
  lambda: LambdaClient,
  registered: RegisteredFunction[],
  project: string,
  functionName: string,
  req: { aliasName: string; version: number },
): Promise<PointAliasResult> {
  const registration = registrationFor(functionName, registered, project);
  if (!registration) {
    return { ok: false, status: 400, message: `${functionName} isn't registered for rollback (rollback-config.json): its aliases can't be changed here` };
  }
  const res = await lambda.send(new InvokeCommand({
    FunctionName: registration.rollbackService,
    Payload: new TextEncoder().encode(JSON.stringify({
      type: 'point-alias', functionName, aliasName: req.aliasName, version: req.version, actor: 'dashboard',
    })),
  }));
  const payload = res.Payload ? new TextDecoder().decode(res.Payload) : '';
  if (res.FunctionError) {
    console.error(`Pointing ${functionName}:${req.aliasName} to ${req.version} failed`, payload);
    return { ok: false, status: 502, message: `The rollback service could not point ${functionName}:${req.aliasName} to version ${req.version}` };
  }
  const result = payload ? JSON.parse(payload) : undefined;
  // e.g. already there, or not archived: the rollback service says why
  if (result?.pointed !== true) return { ok: false, status: 409, message: result?.reason ?? 'The rollback service changed nothing' };
  return { ok: true, result };
}
