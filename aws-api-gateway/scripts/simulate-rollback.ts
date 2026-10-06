/**
 * Invokes the rollback Lambda with a synthetic CloudWatch ALARM notification,
 * exactly as SNS would. The normal checks still apply (rollback window, previous
 * deployment exists, latest is not already a rollback).
 *
 * Usage: npx tsx scripts/simulate-rollback.ts --env dev [--alarm 5xx]
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { log, parseCli, run } from './lib/cli.js';
import { requireStackOutputs } from './lib/stack.js';

run(async () => {
  const { config, values } = parseCli(['alarm'] as const);
  const outputs = await requireStackOutputs(config);
  const alarmName = values.alarm === '4xx' ? outputs.Alarm4xxName : outputs.Alarm5xxName;

  const event = {
    Records: [{
      EventSource: 'aws:sns',
      Sns: {
        Message: JSON.stringify({
          AlarmName: alarmName,
          NewStateValue: 'ALARM',
          NewStateReason: 'Simulated by scripts/simulate-rollback.ts',
        }),
      },
    }],
  };
  log(`Invoking ${outputs.RollbackFunctionName} with simulated ALARM for ${alarmName}`);
  const res = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: outputs.RollbackFunctionName,
    Payload: new TextEncoder().encode(JSON.stringify(event)),
  }));
  const payload = res.Payload ? new TextDecoder().decode(res.Payload) : '';
  if (res.FunctionError) throw new Error(`Rollback Lambda failed: ${payload}`);
  process.stdout.write(`${payload}\n`);
});
