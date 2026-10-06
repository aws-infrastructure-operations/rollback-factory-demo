/**
 * Integration tests against the deployed service-lambda-<env> (LAMBDA_ENV, default dev), through the
 * alias LAMBDA_ALIAS (default integration: what CI tests before promoting it to live). Calls to
 * `integration` never count toward the errors alarm, which watches live and $LATEST only.
 * Set LAMBDA_VERSION to fail unless the alias serves that version.
 *
 * Needs AWS credentials that can read and invoke the function.
 */
import { strict as assert } from 'node:assert';
import { before, describe, test } from 'node:test';
import { getConfig, INTEGRATION_ALIAS, LIVE_ALIAS } from '../lib/config.js';
import { aliasVersion, invokeJson } from '../scripts/lib/aws.js';

const config = getConfig(process.env.LAMBDA_ENV ?? 'dev');
const alias = process.env.LAMBDA_ALIAS || INTEGRATION_ALIAS;
if (alias !== INTEGRATION_ALIAS && alias !== LIVE_ALIAS) {
  throw new Error(`LAMBDA_ALIAS must be ${INTEGRATION_ALIAS} or ${LIVE_ALIAS}, got ${alias}`);
}

let version: string;

before(async () => {
  const target = await aliasVersion(config.functionName, alias);
  if (!target) throw new Error(`${config.functionName}:${alias} doesn't exist - deploy it first`);
  version = target.version;
  const expected = process.env.LAMBDA_VERSION;
  if (expected && expected !== version) {
    throw new Error(`${config.functionName}:${alias} serves version ${version}, expected ${expected}`);
  }
});

describe(`${config.functionName}:${alias}`, () => {
  test('answers without a function error and reports the version it runs as', async () => {
    assert.deepEqual(await invokeJson(config.functionName, {}, alias), { version });
  });

  test('keeps answering on repeated calls', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => invokeJson<{ version: string }>(config.functionName, {}, alias)),
    );
    assert.deepEqual(results.map((r) => r.version), Array(5).fill(version));
  });
});
