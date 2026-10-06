/**
 * Sends real HTTPS traffic to the deployed API (what CloudWatch alarms see; the
 * console's "Test" button doesn't count) until the rollback Lambda records a
 * rollback, then checks the API is healthy again. Used by the break-api demo.
 *
 * Usage:
 *   npx tsx scripts/generate-traffic.ts --env dev --preflight          # is there a deployment to roll back to?
 *   npx tsx scripts/generate-traffic.ts --env dev [--minutes 10] [--interval 3]
 *
 * Exits 0 once a rollback happened and the API answers 200 again, 1 otherwise.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { getConfig } from '../lib/config.js';
import { DeploymentRecord, listDeployments } from '../lambda/shared/deployments.js';
import { log, run } from './lib/cli.js';
import { deleteUser, ensureUser, getIdToken, randomPassword } from './lib/cognito.js';
import { deploymentTarget, requireStackOutputs } from './lib/stack.js';

const HEALTHY_CHECKS = 5;

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
  const target = deploymentTarget(config, outputs);
  const latest = async (): Promise<DeploymentRecord | undefined> =>
    (await listDeployments(target.table, target.apiName, 1))[0];

  if (values.preflight) {
    const baseline = await latest();
    if (!baseline) throw new Error(`No deployment recorded for ${config.apiName} - deploy main first, nothing to roll back to`);
    log(`Rollback target available: ${baseline.deployedAt} (${baseline.source}, deployment ${baseline.deploymentId})`);
    return;
  }

  const baseline = await latest();
  log(`Latest deployment: ${baseline?.deployedAt} (${baseline?.source}) - waiting for a rollback after it`);

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

    const deadline = Date.now() + minutes * 60_000;
    const statuses = new Map<number, number>();
    let rollback: DeploymentRecord | undefined;
    let lastReport = Date.now();
    let i = 0;

    while (Date.now() < deadline && !rollback) {
      const status = await call(i++ % 2 ? '/messages' : '/users');
      statuses.set(status, (statuses.get(status) ?? 0) + 1);

      if (Date.now() - lastReport >= 30_000) {
        const summary = [...statuses].map(([s, n]) => `${s}x${n}`).join(' ');
        log(`  ${new Date().toISOString()} last 30s: ${summary}`);
        statuses.clear();
        lastReport = Date.now();

        const current = await latest();
        if (current?.source === 'rollback' && current.deployedAt !== baseline?.deployedAt) rollback = current;
      }
      await sleep(intervalMs);
    }

    if (!rollback) {
      throw new Error(
        `No rollback recorded within ${minutes} min - check the alarm states and the logs of ${outputs.RollbackFunctionName}`,
      );
    }
    log(`Rollback recorded at ${rollback.deployedAt}: ${rollback.description}`);

    // The new stage deployment can take a few seconds to serve everywhere.
    const healthyBy = Date.now() + 2 * 60_000;
    let healthy = 0;
    while (healthy < HEALTHY_CHECKS && Date.now() < healthyBy) {
      const status = await call(healthy % 2 ? '/messages' : '/users');
      healthy = status === 200 ? healthy + 1 : 0;
      await sleep(2_000);
    }
    if (healthy < HEALTHY_CHECKS) throw new Error('Rolled back, but the API still does not answer 200');
    log(`API healthy again: ${HEALTHY_CHECKS} consecutive 200 responses`);
  } finally {
    await deleteUser(outputs.UserPoolId, username);
  }
});
