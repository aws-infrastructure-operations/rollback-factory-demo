/**
 * Sends real browser-like traffic to the deployed site for a fixed time (what the CloudFront
 * alarms see): each round loads index.html and app.html and everything they reference, as a
 * browser would. Every 30 s it reports the status codes, the 4xx share and the release the
 * distribution points at, so a rollback shows up in the log. It never rolls back or waits for
 * one: that is the alarm -> SNS -> rollback Lambda path. Used by the break-frontend demo.
 *
 * Usage:
 *   npx tsx scripts/generate-traffic.ts --env dev --preflight     # is there a release to roll back to?
 *   npx tsx scripts/generate-traffic.ts --env dev [--minutes 10] [--interval 2]
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { getLiveReleaseId } from '../lambda/shared/releases.js';
import { cloudfront } from './lib/activate.js';
import { log, parseCli, run } from './lib/cli.js';
import { deploymentStore, requireFrontendOutputs } from './lib/stack.js';
import { pageResources, StatusCounter } from './lib/traffic.js';

const REPORT_EVERY_MS = 30_000;

run(async () => {
  const { config, values } = parseCli(['minutes', 'interval'], ['preflight']);
  const minutes = Number(values.minutes ?? 10);
  const intervalMs = Number(values.interval ?? 2) * 1000;
  if (!(minutes > 0) || !(intervalMs > 0)) throw new Error('--minutes and --interval must be positive numbers');
  const outputs = await requireFrontendOutputs(config);

  if (values.preflight) {
    // Same rule as the rollback Lambda: only a verified release that was never rolled back is a target.
    const records = await deploymentStore(config, outputs).list(20);
    const rolledBack = new Set(records.filter((r) => r.rolledBackAt).map((r) => r.releaseId));
    const target = records.find((r) => r.verifiedAt && !rolledBack.has(r.releaseId));
    if (!target) {
      throw new Error(
        `No verified release of ${config.frontendName} - deploy main through CI (the integration tests mark it verified) `
        + 'first, otherwise there is nothing safe to roll back to',
      );
    }
    log(`Rollback target available: release ${target.releaseId} (${target.source}, ${target.deployedAt}, verified ${target.verifiedAt})`);
    return;
  }

  const site = outputs.SiteUrl.replace(/\/$/, '');
  const get = async (url: string) => {
    try {
      const res = await fetch(`${site}${url}`);
      return { status: res.status, body: url.endsWith('.html') ? await res.text() : (await res.arrayBuffer(), '') };
    } catch {
      return { status: 0, body: '' };
    }
  };

  log(`Sending traffic to ${site} for ${minutes} min (one page round every ${intervalMs / 1000}s)`);
  const deadline = Date.now() + minutes * 60_000;
  const window = new StatusCounter();
  const total = new StatusCounter();
  let lastReport = Date.now();
  let liveRelease = await getLiveReleaseId(cloudfront, outputs.DistributionId);
  log(`  distribution serves release ${liveRelease}`);

  const report = async () => {
    const now = await getLiveReleaseId(cloudfront, outputs.DistributionId).catch(() => liveRelease);
    const switched = now !== liveRelease ? `  <- origin path switched from ${liveRelease} (rollback?)` : '';
    log(`  ${new Date().toISOString()} ${window} (4xx ${(window.rate4xx * 100).toFixed(0)}%), release ${now}${switched}`);
    liveRelease = now;
    window.clear();
    lastReport = Date.now();
  };

  while (Date.now() < deadline) {
    for (const page of ['/index.html', '/app.html']) {
      const { status, body } = await get(page);
      window.add(status);
      total.add(status);
      for (const url of pageResources(body)) {
        const resource = await get(url);
        window.add(resource.status);
        total.add(resource.status);
      }
    }
    if (Date.now() - lastReport >= REPORT_EVERY_MS) await report();
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  if (window.total) await report();
  log(`Done: ${total.total} requests (${total}, 4xx ${(total.rate4xx * 100).toFixed(0)}%)`);
});
