/**
 * Invokes the rollback Lambda with a CloudWatch-style ALARM notification, exactly as SNS
 * would. Used to exercise rollbacks by hand; the Lambda's normal checks still apply (rollback
 * window, an earlier verified release exists, the latest deployment isn't already a rollback).
 *
 * Usage: npx tsx scripts/trigger-rollback.ts --env dev [--alarm 4xx|5xx] [--reason "..."]
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { log, parseCli, run } from './lib/cli.js';
import { requireAlarmsOutputs } from './lib/stack.js';

run(async () => {
  const { config, values } = parseCli(['alarm', 'reason']);
  const outputs = await requireAlarmsOutputs(config);
  const alarmName = values.alarm === '5xx' ? outputs.Alarm5xxName : outputs.Alarm4xxName;
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
  const res = await new LambdaClient({ region: config.alarmsRegion }).send(new InvokeCommand({
    FunctionName: outputs.RollbackFunctionName,
    Payload: new TextEncoder().encode(JSON.stringify(event)),
  }));
  const payload = res.Payload ? new TextDecoder().decode(res.Payload) : '';
  if (res.FunctionError) throw new Error(`Rollback Lambda failed: ${payload}`);
  process.stdout.write(`${payload}\n`);
});
