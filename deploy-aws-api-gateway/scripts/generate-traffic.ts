/**
 * Sends real HTTPS traffic to the deployed API for a fixed time (what CloudWatch
 * alarms see; the console's "Test" button doesn't count) and reports the status
 * codes every 30 s. It does not roll back or wait for a rollback: that is the
 * job of the alarm -> SNS -> rollback Lambda path. Used by the break-api demo.
 *
 * Usage:
 *   npx tsx scripts/generate-traffic.ts --env dev --preflight          # is there a deployment to roll back to?
 *   npx tsx scripts/generate-traffic.ts --env dev [--minutes 10] [--interval 3]
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { getConfig } from '../lib/config.js';
import { listDeployments } from '../lambda/shared/deployments.js';
import { log, run } from './lib/cli.js';
import { deleteUser, ensureUser, getIdToken, randomPassword } from './lib/cognito.js';
import { deploymentTarget, requireStackOutputs } from './lib/stack.js';

run(async () => {
  const { values } = parseArgs({
    options: {
      env: { type: 'string' },
      minutes: { type: 'string', default: '10' },
      interval: { type: 'string', default: '3' },
      preflight: { type: 'boolean', default: false },
    },
  });
  const config = getConfig(values.env ?? process.env.API_ENV ?? 'dev');
  const minutes = Number(values.minutes);
  const intervalMs = Number(values.interval) * 1000;
  if (!(minutes > 0) || !(intervalMs > 0)) throw new Error('--minutes and --interval must be positive numbers');

  const outputs = await requireStackOutputs(config);

  if (values.preflight) {
    const target = deploymentTarget(config, outputs);
    // Same rule as the rollback Lambda: only a verified, never rolled back deployment is a target.
    const records = await listDeployments(target.table, target.apiName, 20);
    const baseline = records.find((r) => r.verifiedAt && !r.rolledBackAt);
    if (!baseline) {
      throw new Error(
        `No verified deployment of ${config.apiName} - deploy main through CI (integration tests mark it verified) first, `
        + 'otherwise there is nothing safe to roll back to',
      );
    }
    log(`Rollback target available: ${baseline.deployedAt} (${baseline.source}, deployment ${baseline.deploymentId}, verified ${baseline.verifiedAt})`);
    return;
  }

  const username = `traffic-${randomUUID()}@example.com`;
  const password = randomPassword();
  await ensureUser(outputs.UserPoolId, username, password);
  try {
    const token = await getIdToken(outputs.UserPoolClientId, username, password);
    const baseUrl = outputs.ApiUrl.replace(/\/$/, '');
    const call = async (path: string) => {
      try {
        return (await fetch(`${baseUrl}${path}`, { headers: { Authorization: token } })).status;
      } catch {
        return 0; // network error
      }
    };

    log(`Sending traffic to ${baseUrl} for ${minutes} min (one request every ${intervalMs / 1000}s)`);
    const deadline = Date.now() + minutes * 60_000;
    const window = new Map<number, number>();
    const total = new Map<number, number>();
    const count = (m: Map<number, number>, status: number) => m.set(status, (m.get(status) ?? 0) + 1);
    const summary = (m: Map<number, number>) => [...m].map(([s, n]) => `${s || 'network-error'}x${n}`).join(' ');
    let lastReport = Date.now();
    let i = 0;

    while (Date.now() < deadline) {
      const status = await call(['/users', '/messages', '/orders'][i++ % 3]);
      count(window, status);
      count(total, status);
      if (Date.now() - lastReport >= 30_000) {
        log(`  ${new Date().toISOString()} last 30s: ${summary(window)}`);
        window.clear();
        lastReport = Date.now();
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
    if (window.size) log(`  ${new Date().toISOString()} last ${Math.round((Date.now() - lastReport) / 1000)}s: ${summary(window)}`);
    log(`Done: ${i} requests (${summary(total)})`);
  } finally {
    await deleteUser(outputs.UserPoolId, username);
  }
});
