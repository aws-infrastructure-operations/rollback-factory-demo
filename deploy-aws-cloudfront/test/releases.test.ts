import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  CloudFrontClient, CreateInvalidationCommand, GetDistributionConfigCommand, UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  cacheControlFor, contentTypeFor, manifestKey, originPathFor, releaseIdFor, releaseIdFromOriginPath, switchRelease,
} from '../lambda/shared/releases.js';
import { describeFiles } from '../scripts/lib/manifest.js';

test('release ids are compact UTC timestamps', () => {
  assert.equal(releaseIdFor(new Date('2026-10-06T12:30:05.123Z')), '20261006T123005Z');
});

test('maps releases to origin paths and back', () => {
  assert.equal(originPathFor('20261006T123005Z'), '/releases/20261006T123005Z');
  assert.equal(releaseIdFromOriginPath('/releases/20261006T123005Z'), '20261006T123005Z');
  assert.equal(releaseIdFromOriginPath('/releases/initial'), 'initial');
  for (const other of [undefined, '', '/', '/releases/', '/releases/latest', '/other/20261006T123005Z', '/releases/20261006T123005Z/x']) {
    assert.equal(releaseIdFromOriginPath(other), undefined, String(other));
  }
});

test('stores manifests under <frontendName>/<releaseId>/', () => {
  assert.equal(manifestKey('frontend-user-dev', '20261006T123005Z'), 'frontend-user-dev/20261006T123005Z/manifest.json');
});

test('serves HTML uncached and hashed assets for a year', () => {
  assert.equal(cacheControlFor('index.html'), 'no-cache');
  assert.equal(cacheControlFor('assets/app-Bbx963EB.js'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('favicon.svg'), 'public, max-age=3600');
  assert.equal(contentTypeFor('app.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('assets/page-BwW5LA7K.css'), 'text/css; charset=utf-8');
  assert.equal(contentTypeFor('assets/app.JS'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('assets/blob.bin'), 'application/octet-stream');
});

test('describes a build directory with sizes and sha256 hashes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'release-'));
  try {
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'index.html'), 'hello');
    await writeFile(path.join(dir, 'assets', 'app-abc.js'), '');
    assert.deepEqual(await describeFiles(dir), [
      {
        path: 'assets/app-abc.js',
        size: 0,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        contentType: 'text/javascript; charset=utf-8',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      {
        path: 'index.html',
        size: 5,
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        contentType: 'text/html; charset=utf-8',
        cacheControl: 'no-cache',
      },
    ]);
    await rm(path.join(dir, 'assets'), { recursive: true });
    await rm(path.join(dir, 'index.html'));
    await assert.rejects(describeFiles(dir), /is empty/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A CloudFront client that serves one distribution config and records the commands. */
const fakeCloudFront = (originPath: string) => {
  const sent: any[] = [];
  const client = {
    send: async (command: any) => {
      sent.push(command);
      if (command instanceof GetDistributionConfigCommand) {
        return {
          ETag: 'etag-1',
          DistributionConfig: { Comment: 'frontend-user-dev', Origins: { Quantity: 1, Items: [{ Id: 'site', OriginPath: originPath }] } },
        };
      }
      if (command instanceof UpdateDistributionCommand) return {};
      if (command instanceof CreateInvalidationCommand) return { Invalidation: { Id: 'inv-1' } };
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
  return { client: client as unknown as CloudFrontClient, sent };
};

test('switches the origin path with the ETag and invalidates everything', async () => {
  const { client, sent } = fakeCloudFront('/releases/20261006T120000Z');

  const result = await switchRelease(client, 'DIST', '20261006T123005Z', 'ref-1');

  assert.deepEqual(result, {
    previousReleaseId: '20261006T120000Z', releaseId: '20261006T123005Z', changed: true, invalidationId: 'inv-1',
  });
  const update: any = sent.find((c) => c instanceof UpdateDistributionCommand);
  assert.equal(update.input.Id, 'DIST');
  assert.equal(update.input.IfMatch, 'etag-1');
  assert.equal(update.input.DistributionConfig.Origins.Items[0].OriginPath, '/releases/20261006T123005Z');
  assert.equal(update.input.DistributionConfig.Comment, 'frontend-user-dev', 'the rest of the config is sent back unchanged');
  const invalidation: any = sent.find((c) => c instanceof CreateInvalidationCommand);
  assert.deepEqual(invalidation.input, {
    DistributionId: 'DIST',
    InvalidationBatch: { CallerReference: 'ref-1', Paths: { Quantity: 1, Items: ['/*'] } },
  });
});

test('skips the distribution update when the release is already live, but still invalidates', async () => {
  const { client, sent } = fakeCloudFront('/releases/20261006T123005Z');

  const result = await switchRelease(client, 'DIST', '20261006T123005Z', 'ref-1');

  assert.equal(result.changed, false);
  assert.equal(sent.some((c) => c instanceof UpdateDistributionCommand), false);
  assert.equal(sent.some((c) => c instanceof CreateInvalidationCommand), true);
});

test('refuses release ids that could escape the releases/ prefix', async () => {
  const { client, sent } = fakeCloudFront('/releases/initial');
  await assert.rejects(switchRelease(client, 'DIST', '../secret', 'ref-1'), /Release ids look like/);
  assert.equal(sent.length, 0);
});
