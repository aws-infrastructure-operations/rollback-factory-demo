/**
 * Smoke tests against the deployed distribution of FRONTEND_ENV (default dev): the live
 * release is served over HTTPS, byte for byte as its manifest says, with the right headers,
 * and the bucket behind it stays private.
 *
 * Needs AWS credentials that can read the stack, the distribution and the deployments bucket.
 * Set FRONTEND_RELEASE to fail unless that release is live (CI, after activating it).
 *
 * Keep the number of intentional 4xx small: they count towards the 4xx alarm.
 */
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { releasePrefix } from '../lambda/shared/releases.js';
import { config, LiveSite, liveSite, target } from './lib/site.js';

let site: LiveSite;

before(async () => {
  site = await liveSite();
});

const sha256 = (body: ArrayBuffer) => createHash('sha256').update(Buffer.from(body)).digest('hex');

describe(`${config.frontendName}${target === 'integration' ? '-integration' : ''} smoke`, () => {
  test('serves the live release\'s index.html at / over HTTPS', async () => {
    const res = await fetch(`${site.siteUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    const index = site.manifest.files.find((f) => f.path === 'index.html');
    assert.ok(index, 'the manifest lists index.html');
    // the HTML references hashed assets, so matching it proves which release is served
    assert.equal(sha256(await res.arrayBuffer()), index.sha256, `/ is not index.html of release ${site.releaseId}`);
  });

  test('the dashboard API needs a signed-in user; only the sign-in settings are public', async () => {
    const settings = await fetch(`${site.siteUrl}/api/auth/config`);
    assert.equal(settings.status, 200);
    assert.deepEqual(await settings.json(), {
      region: site.region,
      userPoolId: site.outputs.DashboardUserPoolId,
      clientId: site.outputs.DashboardUserPoolClientId,
    });
    // one intentional 401 (it counts toward the 4xx alarm on the live distribution)
    const data = await fetch(`${site.siteUrl}/api/api-gateways`);
    assert.equal(data.status, 401);
    assert.deepEqual(await data.json(), { message: 'Sign in required' });
  });

  test('redirects HTTP to HTTPS', async () => {
    const res = await fetch(`${site.siteUrl.replace(/^https:/, 'http:')}/`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.match(res.headers.get('location') ?? '', /^https:\/\//);
  });

  test('serves every file of the manifest with its hash, content type and cache policy', async () => {
    const problems: string[] = [];
    await Promise.all(site.manifest.files.map(async (file) => {
      const res = await fetch(`${site.siteUrl}/${file.path}`);
      if (res.status !== 200) return void problems.push(`${file.path}: HTTP ${res.status}`);
      const contentType = res.headers.get('content-type');
      const cacheControl = res.headers.get('cache-control');
      if (contentType !== file.contentType) problems.push(`${file.path}: content-type ${contentType}, expected ${file.contentType}`);
      if (cacheControl !== file.cacheControl) problems.push(`${file.path}: cache-control ${cacheControl}, expected ${file.cacheControl}`);
      // fetch decompresses gzip / brotli, so this is the hash of the uploaded file
      if (sha256(await res.arrayBuffer()) !== file.sha256) problems.push(`${file.path}: content differs from the manifest`);
    }));
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('HTML is revalidated, hashed assets are immutable', () => {
    const html = site.manifest.files.filter((f) => f.path.endsWith('.html'));
    const assets = site.manifest.files.filter((f) => f.path.startsWith('assets/'));
    assert.deepEqual(html.map((f) => f.path), ['index.html']);
    assert.ok(assets.length > 0, 'the release has assets');
    assert.ok(html.every((f) => f.cacheControl === 'no-cache'));
    assert.ok(assets.every((f) => f.cacheControl.includes('immutable')));
  });

  test('answers an unknown path with a 4xx, not index.html (no SPA fallback)', async () => {
    const res = await fetch(`${site.siteUrl}/does-not-exist-${randomUUID()}.html`);
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
    assert.doesNotMatch(await res.text(), /<html/i);
  });

  test('keeps the bucket private: S3 refuses direct requests', async () => {
    const res = await fetch(
      `https://${site.outputs.SiteBucketName}.s3.${site.region}.amazonaws.com/${releasePrefix(site.releaseId)}/index.html`,
    );
    assert.equal(res.status, 403);
  });
});
