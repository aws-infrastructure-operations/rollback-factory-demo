/**
 * Bake period after a deployment: polls the API's 4xx/5xx alarms for --minutes.
 * If one goes into ALARM, waits for the rollback Lambda to record its rollback
 * and exits 1 either way (the deployment is bad). Exits 0 if the alarms stay quiet.
 *
 * Usage: npx tsx scripts/watch-alarms.ts --env prod [--minutes 10] [--interval 30]
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { listDeployments } from '../lambda/shared/deployments.js';
import { log, parseCli, run } from './lib/cli.js';
import { deploymentTarget, requireStackOutputs } from './lib/stack.js';

const ROLLBACK_WAIT_MS = 5 * 60_000;

run(async () => {
  const { config, values } = parseCli(['minutes', 'interval'] as const);
  const minutes = Number(values.minutes ?? 10);
  const intervalMs = Number(values.interval ?? 30) * 1000;
  if (!(minutes >= 0) || !(intervalMs > 0)) {
    throw new Error(`--minutes and --interval must be numbers, got "${values.minutes}" / "${values.interval}"`);
  }
  const outputs = await requireStackOutputs(config);
  const target = deploymentTarget(config, outputs);
  const alarmNames = [outputs.Alarm4xxName, outputs.Alarm5xxName];
  const cloudwatch = new CloudWatchClient({});

  const [baseline] = await listDeployments(target.table, target.apiName, 1);
  log(`Watching ${alarmNames.join(', ')} for ${minutes} min (latest deployment: ${baseline?.deployedAt ?? 'none'})`);

  const deadline = Date.now() + minutes * 60_000;
  let firing: string[] = [];
  while (Date.now() < deadline) {
    const { MetricAlarms = [] } = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: alarmNames }));
    firing = MetricAlarms.filter((a) => a.StateValue === 'ALARM').map((a) => `${a.AlarmName} (${a.StateReason})`);
    if (firing.length) break;
    const states = MetricAlarms.map((a) => `${a.AlarmName}=${a.StateValue}`).join(' ');
    log(`  ${new Date().toISOString()} ${states} - ${Math.ceil((deadline - Date.now()) / 60_000)} min left`);
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  if (!firing.length) {
    log('Alarms stayed OK - deployment is healthy');
    return;
  }

  log(`ALARM: ${firing.join('; ')}`);
  log('Waiting for the rollback Lambda...');
  const waitUntil = Date.now() + ROLLBACK_WAIT_MS;
  while (Date.now() < waitUntil) {
    const [latest] = await listDeployments(target.table, target.apiName, 1);
    if (latest?.source === 'rollback' && latest.deployedAt !== baseline?.deployedAt) {
      log(`Rolled back: ${latest.description ?? ''}`);
      log(`  spec: s3://${latest.specBucket}/${latest.specKey}`);
      throw new Error('Deployment was rolled back after an alarm');
    }
    await sleep(15_000);
  }
  throw new Error(
    'Alarm fired but no rollback was recorded (outside the rollback window, alarm actions disabled, '
    + `or the rollback Lambda failed - check the logs of ${outputs.RollbackFunctionName})`,
  );
});
