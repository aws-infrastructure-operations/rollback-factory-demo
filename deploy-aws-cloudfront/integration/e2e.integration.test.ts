/**
 * End-to-end test in a headless Chromium against the deployed site of FRONTEND_ENV (on the
 * FRONTEND_TARGET distribution): the page loads with its scripts and styles and shows the
 * environment and the release the distribution serves, and the API Gateways panel loads from the
 * dashboard API (/api/*). Fails on any browser console error or failed request.
 *
 * Needs AWS credentials that can read the stack and the distribution, and Chromium for
 * Playwright (npx playwright install chromium). FRONTEND_RELEASE as in smoke.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import { Browser, chromium, Page } from 'playwright';
import { config, LiveSite, liveSite, target } from './lib/site.js';

const TIMEOUT_MS = 20_000;

let site: LiveSite;
let browser: Browser;
let page: Page;
/** Console errors, failed requests and HTTP errors the page ran into. */
const problems: string[] = [];

before(async () => {
  site = await liveSite();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('requestfailed', (req) => problems.push(`request failed: ${req.method()} ${req.url()} (${req.failure()?.errorText})`));
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.request().method()} ${res.url()}`);
  });
});

after(async () => {
  await browser?.close();
});

describe(`${config.frontendName}${target === 'integration' ? '-integration' : ''} end to end`, () => {
  test('loads the page with its scripts and styles, without errors', async () => {
    await page.goto(`${site.siteUrl}/`);
    // React rendered the dashboard, and the API Gateways panel loaded (or failed) from /api
    await page.getByRole('heading', { name: 'API Gateways' }).waitFor();
    await page.locator('#api-gateways:not([data-state="loading"])').waitFor();
    assert.equal(await page.locator('#api-gateways').getAttribute('data-state'), 'ready');
    // the stylesheet applied: the page is laid out as a grid
    assert.equal(await page.locator('.layout').evaluate((el) => (globalThis as any).getComputedStyle(el).display), 'grid');
    assert.deepEqual(problems.splice(0), []);
  });

  test('shows the environment and the release the distribution serves', async () => {
    assert.equal(await page.locator('#env').textContent(), config.envName);
    assert.equal(await page.locator('#release').textContent(), site.releaseId);
    assert.equal(await page.locator('#footer-release').textContent(), site.releaseId);
    assert.notEqual(await page.locator('#built').textContent(), 'local build');
  });

  test('serves the dashboard API through the distribution', async () => {
    const response = await page.request.get(`${site.siteUrl}/api/api-gateways`);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['cache-control'], 'no-store');
    const body = await response.json();
    assert.equal(typeof body.region, 'string');
    assert.ok(Array.isArray(body.apis));
    // each listed API is a row of the panel
    const rows = await page.locator('#api-gateways tbody tr:not(:has(td.state))').count();
    assert.equal(rows, body.apis.length);
  });
});
