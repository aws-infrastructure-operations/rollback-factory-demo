/**
 * End-to-end test in a headless Chromium against the deployed site of FRONTEND_ENV:
 * sign in with a throw-away Cognito user, call GET and POST on /users and /messages through
 * the page, sign out. Fails on any browser console error or failed request (CORS, assets).
 *
 * Needs AWS credentials that can read the stacks and administer the API's user pool, and
 * Chromium for Playwright (npx playwright install chromium). FRONTEND_RELEASE as in smoke.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Browser, chromium, Page } from 'playwright';
import { createUser, deleteUser, randomPassword } from '../scripts/lib/cognito.js';
import { requireApiOutputs } from '../scripts/lib/stack.js';
import { config, LiveSite, liveSite, target } from './lib/site.js';

const TIMEOUT_MS = 20_000;

let site: LiveSite;
let browser: Browser;
let page: Page;
let userPoolId: string;
const username = `frontend-e2e-${randomUUID()}@example.com`;
const password = randomPassword();
let userCreated = false;
/** Console errors, failed requests and HTTP errors the page ran into. */
const problems: string[] = [];

before(async () => {
  site = await liveSite();
  userPoolId = (await requireApiOutputs(config)).UserPoolId;
  await createUser(userPoolId, username, password);
  userCreated = true;

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
  if (userCreated) await deleteUser(userPoolId, username);
});

/** Problems collected since the last check, so each test reports its own. */
const takeProblems = () => problems.splice(0);

describe(`${config.frontendName}${target === 'integration' ? '-integration' : ''} end to end`, () => {
  test('redirects to the login page without a session', async () => {
    await page.goto(`${site.siteUrl}/app.html`);
    await page.waitForURL(/\/index\.html$/);
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    assert.equal(await page.locator('#release').textContent(), site.releaseId, 'footer shows the live release');
    assert.deepEqual(takeProblems(), []);
  });

  test('signs in with the API\'s user pool', async () => {
    await page.getByLabel('E-mail').fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/app\.html$/);
    await page.locator('#user').filter({ hasText: username }).waitFor();
    assert.deepEqual(takeProblems(), []);
  });

  for (const resource of ['users', 'messages']) {
    test(`GET /${resource} through the page returns 200`, async () => {
      const section = page.getByRole('region', { name: `/${resource}` });
      await section.getByRole('button', { name: `GET /${resource}` }).click();
      await section.locator('.status.ok').filter({ hasText: `GET /${resource} → 200` }).waitFor();
      assert.match(await section.locator('pre').textContent() ?? '', new RegExp(`"${resource}"`));
      assert.deepEqual(takeProblems(), []);
    });

    test(`POST /${resource} through the page returns 201 and echoes the message`, async () => {
      const message = `e2e ${randomUUID()}`;
      const section = page.getByRole('region', { name: `/${resource}` });
      await section.getByLabel('Message').fill(message);
      await section.getByRole('button', { name: `POST /${resource}` }).click();
      await section.locator('.status.ok').filter({ hasText: `POST /${resource} → 201` }).waitFor();
      assert.match(await section.locator('pre').textContent() ?? '', new RegExp(message));
      assert.deepEqual(takeProblems(), []);
    });
  }

  test('signs out and back to the login page', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/index\.html$/);
    await page.goto(`${site.siteUrl}/app.html`);
    await page.waitForURL(/\/index\.html$/);
    assert.deepEqual(takeProblems(), []);
  });
});
