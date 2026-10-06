/**
 * Invokes the rollback service with a CloudWatch-style ALARM notification of this frontend's 4xx or
 * 5xx alarm, exactly as SNS would. Used to exercise rollbacks by hand; the CloudFront manager's normal
 * checks still apply (rollback window, an earlier verified release exists, the latest deployment
 * isn't already a rollback).
 *
 * Usage: npx tsx scripts/trigger-rollback.ts --env dev [--alarm 4xx|5xx] [--reason "..."]
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DEFAULT_REGION } from '../lib/config.js';
import { log, parseCli, run } from './lib/cli.js';

run(async () => {
  const { config, values } = parseCli(['alarm', 'reason']);
  const alarmName = values.alarm === '5xx' ? config.alarmNames.error5xx : config.alarmNames.error4xx;
  const reason = values.reason ?? 'Triggered manually by scripts/trigger-rollback.ts';

  const event = {
    Records: [{
      EventSource: 'aws:sns',
      Sns: {
        Message: JSON.stringify({ AlarmName: alarmName, NewStateValue: 'ALARM', NewStateReason: reason }),
      },
    }],
  };
  log(`Invoking ${config.rollbackServiceFunctionName} as ${alarmName}: ${reason}`);
  // the rollback service runs in the main region, next to the frontend's main stack
  const res = await new LambdaClient({ region: process.env.AWS_REGION ?? DEFAULT_REGION }).send(new InvokeCommand({
    FunctionName: config.rollbackServiceFunctionName,
    Payload: new TextEncoder().encode(JSON.stringify(event)),
  }));
  const payload = res.Payload ? new TextDecoder().decode(res.Payload) : '';
  if (res.FunctionError) throw new Error(`Rollback service failed: ${payload}`);
  process.stdout.write(`${payload}\n`);
});
