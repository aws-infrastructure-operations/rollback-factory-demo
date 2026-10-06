/**
 * Integration tests against the deployed rollback service of ROLLBACK_ENV (default dev). They only
 * use paths that never change anything, so they are safe in every environment and don't need the
 * project stacks: alarm routing (an OK notification, another environment's alarm, an unknown name)
 * and the Lambda manager's sync of an unregistered function.
 *
 * Needs AWS credentials that can invoke the function.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { alarmName, getConfig } from '../lib/config.js';

const config = getConfig(process.env.ROLLBACK_ENV ?? 'dev');
const lambda = new LambdaClient({});
const otherEnv = config.envName === 'prod' ? 'dev' : 'prod';

async function invoke(payload: unknown): Promise<any> {
  const res = await lambda.send(new InvokeCommand({
    FunctionName: config.functionName,
    Payload: new TextEncoder().encode(JSON.stringify(payload)),
  }));
  const text = res.Payload ? new TextDecoder().decode(res.Payload) : '';
  assert.equal(res.FunctionError, undefined, `function error: ${text}`);
  return JSON.parse(text);
}

const notification = (name: string, state: string) => ({
  Records: [{ Sns: { Message: JSON.stringify({ AlarmName: name, NewStateValue: state, NewStateReason: 'integration test' }) } }],
});

describe(`${config.functionName}`, () => {
  test('routes an alarm by its type and skips an OK transition', async () => {
    for (const type of ['apigateway', 'cloudfront', 'lambda'] as const) {
      const name = alarmName(type, 'integration-test-5xx-rate', config.envName);
      const [result] = await invoke(notification(name, 'OK'));
      assert.deepEqual(result, { alarm: name, manager: type, action: 'skip', reason: 'state is OK, not ALARM' });
    }
  });

  test("never acts on another environment's alarm", async () => {
    const name = alarmName('apigateway', 'api-user-5xx-rate', otherEnv);
    const [result] = await invoke(notification(name, 'ALARM'));
    assert.equal(result.action, 'skip');
    assert.match(result.reason, new RegExp(`belongs to ${otherEnv}`));
  });

  test('skips alarm names outside the convention', async () => {
    const [result] = await invoke(notification('some-other-alarm', 'ALARM'));
    assert.equal(result.action, 'skip');
  });

  test('the Lambda manager refuses to sync a function that is not registered', async () => {
    const [result] = await invoke({ type: 'sync', functionName: 'not-registered-function' });
    assert.deepEqual(result, { rolledBack: false, reason: 'not-registered-function is not registered for rollback (see rollback-config.json)' });
  });
});
