/**
 * End-to-end test in a headless Chromium against the deployed site of FRONTEND_ENV (on the
 * FRONTEND_TARGET distribution): a throw-away user signs in through the sign-in form, then the page
 * shows the environment and the release the distribution serves, and the API Gateways, Lambda
 * Functions and CloudFront Distributions panels load from the dashboard API (/api/*); signing out
 * shows the form again. Fails on any browser console error or failed request.
 *
 * Needs AWS credentials that can read the stack and the distribution and administer the dashboard's
 * user pool (the test user is created and deleted), and Chromium for Playwright
 * (npx playwright install chromium). FRONTEND_RELEASE as in smoke.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import { Browser, chromium, Page } from 'playwright';
import { config, LiveSite, liveSite, target } from './lib/site.js';
import { AUTH_HEADER, createTestUser, TestUser } from './lib/user.js';

const TIMEOUT_MS = 20_000;

let site: LiveSite;
let user: TestUser;
let browser: Browser;
let page: Page;
/** Console errors, failed requests and HTTP errors the page ran into. */
const problems: string[] = [];

before(async () => {
  site = await liveSite();
  user = await createTestUser(site.outputs);
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
  await user?.remove();
});

/** GET on the dashboard API through the distribution, signed in as the test user. */
const api = (path: string) => page.request.get(`${site.siteUrl}${path}`, { headers: { [AUTH_HEADER]: user.idToken } });

describe(`${config.frontendName}${target === 'integration' ? '-integration' : ''} end to end`, () => {
  test('loads the page with its scripts and styles, and signs in through the form, without errors', async () => {
    await page.goto(`${site.siteUrl}/`);
    // signed out, the page shows only the sign-in form: no dashboard, no call to the API's data
    await page.locator('#login').waitFor();
    assert.equal(await page.locator('.layout').count(), 0);
    await page.locator('#login-email').fill(user.email);
    await page.locator('#login-password').fill(user.password);
    await page.locator('#login-submit').click();
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
    const response = await api('/api/api-gateways');
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['cache-control'], 'no-store');
    const body = await response.json();
    assert.equal(typeof body.region, 'string');
    assert.ok(Array.isArray(body.apis));
    // each listed API is a row of the panel
    const rows = await page.locator('#api-gateways tbody tr:not(:has(td.state))').count();
    assert.equal(rows, body.apis.length);
  });

  test('shows the selected API\'s stages from the dashboard API', async (t) => {
    const { apis } = await (await api('/api/api-gateways')).json();
    if (!apis.length) return t.skip('no API Gateway in the region');
    const [first] = apis;
    const response = await api(`/api/api-gateways/${first.id}?type=${first.type}`);
    assert.equal(response.status(), 200);
    const details = await response.json();
    assert.equal(details.id, first.id);
    assert.deepEqual(details.stages.map((s: { name: string }) => s.name), first.stages);
    // the first API is selected and its details loaded without errors
    await page.locator('#api-gateway-details:not([data-state="loading"])').waitFor();
    assert.equal(await page.locator('#api-gateway-details').getAttribute('data-state'), 'ready');
    assert.match((await page.locator('#api-gateway-details h2').textContent()) ?? '', new RegExp(first.name));
    assert.deepEqual(problems.splice(0), []);
  });

  test('lists the Lambda functions and shows the selected one, without environment variables', async (t) => {
    await page.locator('#lambda-functions:not([data-state="loading"])').waitFor();
    assert.equal(await page.locator('#lambda-functions').getAttribute('data-state'), 'ready');
    const response = await api('/api/lambda-functions');
    assert.equal(response.status(), 200);
    const { functions } = await response.json();
    assert.equal(await page.locator('#lambda-functions tbody tr:not(:has(td.state))').count(), functions.length);
    if (!functions.length) return t.skip('no Lambda function in the region');

    const details = await api(`/api/lambda-functions/${functions[0].name}`);
    assert.equal(details.status(), 200);
    const body = await details.text();
    assert.doesNotMatch(body, /"Environment"|"Variables"/, 'environment variables are never sent');
    await page.locator('#lambda-function-details:not([data-state="loading"])').waitFor();
    assert.equal(await page.locator('#lambda-function-details').getAttribute('data-state'), 'ready');
    assert.deepEqual(problems.splice(0), []);
  });

  test('lists this distribution with the release it serves, and its history for the live one', async () => {
    await page.locator('#cloudfront-distributions:not([data-state="loading"])').waitFor();
    assert.equal(await page.locator('#cloudfront-distributions').getAttribute('data-state'), 'ready');
    const response = await api('/api/cloudfront-distributions');
    assert.equal(response.status(), 200);
    const { distributions } = await response.json();
    const self = distributions.find((d: { name: string }) => d.name === site.name);
    assert.ok(self, `${site.name} is listed`);
    assert.equal(self.releaseId, site.releaseId);

    const details = await api(`/api/cloudfront-distributions/${self.id}`);
    assert.equal(details.status(), 200);
    const body = await details.json();
    // only the distribution clients use has a release history (the integration one has none)
    assert.equal(body.tracked, target !== 'integration');
    assert.doesNotMatch(JSON.stringify(body), /CustomHeaders|HeaderValue/, 'origin headers are never sent');
    await page.locator('#cloudfront-distribution-details:not([data-state="loading"])').waitFor();
    assert.equal(await page.locator('#cloudfront-distribution-details').getAttribute('data-state'), 'ready');
    assert.deepEqual(problems.splice(0), []);
  });

  test('the region picker starts on the dashboard region and switches the API Gateways panel', async () => {
    assert.equal(await page.getByText('AWS Account').count(), 0, 'no account picker');
    const picker = page.locator('#region-picker');
    await picker.locator('option').nth(1).waitFor({ state: 'attached' });
    assert.equal(await picker.inputValue(), site.region);
    const other = site.region === 'us-east-1' ? 'eu-west-1' : 'us-east-1';
    const ready = '#api-gateways:not([data-state="loading"])';
    await picker.selectOption(other);
    await page.locator(ready).waitFor();
    assert.equal(await page.locator('#api-gateways').getAttribute('data-state'), 'ready');
    assert.match((await page.locator('#api-gateways').textContent()) ?? '', new RegExp(`in ${other}`));
    // back to the dashboard's own region, where the deployments are recorded
    await picker.selectOption(site.region);
    await page.locator(ready).waitFor();
    assert.match((await page.locator('#api-gateways').textContent()) ?? '', new RegExp(`in ${site.region}`));
    assert.deepEqual(problems.splice(0), []);
  });

  test('shows who is signed in, and signing out returns to the sign-in form', async () => {
    await page.locator('#account-menu').click();
    assert.equal(await page.locator('#signed-in-as').textContent(), user.email);
    await page.locator('#sign-out').click();
    await page.locator('#login').waitFor();
    assert.equal(await page.locator('.layout').count(), 0);
    // nothing of the session is left in the browser
    assert.equal(await page.evaluate(() => (globalThis as any).localStorage.getItem('rollback-dashboard-session')), null);
    assert.deepEqual(problems.splice(0), []);
  });
});
