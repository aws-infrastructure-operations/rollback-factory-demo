/**
 * Invokes the rollback Lambda with a CloudWatch-style ALARM notification, exactly
 * as SNS would. Used by CI when integration tests fail right after a deploy, and
 * to exercise rollbacks by hand. The Lambda's normal checks still apply (rollback
 * window, previous deployment exists, latest is not already a rollback).
 *
 * Usage: npx tsx scripts/trigger-rollback.ts --env dev [--alarm 4xx|5xx] [--reason "..."]
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { log, parseCli, run } from './lib/cli.js';
import { requireStackOutputs } from './lib/stack.js';

run(async () => {
  const { config, values } = parseCli(['alarm', 'reason'] as const);
  const outputs = await requireStackOutputs(config);
  const alarmName = values.alarm === '4xx' ? outputs.Alarm4xxName : outputs.Alarm5xxName;
  const reason = values.reason ?? 'Triggered manually by scripts/trigger-rollback.ts';

  const event = {
    Records: [{
      EventSource: 'aws:sns',
      Sns: {
        Message: JSON.stringify({ AlarmName: alarmName, NewStateValue: 'ALARM', NewStateReason: reason }),
      },
    }],
  };
  log(`Invoking ${outputs.RollbackFunctionName} as ${alarmName}: ${reason}`);
  const res = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: outputs.RollbackFunctionName,
    Payload: new TextEncoder().encode(JSON.stringify(event)),
  }));
  const payload = res.Payload ? new TextDecoder().decode(res.Payload) : '';
  if (res.FunctionError) throw new Error(`Rollback Lambda failed: ${payload}`);
  process.stdout.write(`${payload}\n`);
});
