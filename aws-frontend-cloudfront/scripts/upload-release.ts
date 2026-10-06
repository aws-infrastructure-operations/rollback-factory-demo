/**
 * Uploads the release built by release:build to s3://<site bucket>/releases/<id>/ and stores
 * its build manifest (release id, commit, file list + sha256) in the deployments bucket under
 * <frontendName>/<id>/manifest.json. Releases are immutable: an existing prefix is an error.
 * Doesn't change what the site serves - that's release:activate.
 *
 * Usage: npx tsx scripts/upload-release.ts --env dev [--break missing-assets]
 *
 * --break missing-assets (break-frontend demo only) uploads the HTML but none of assets/, so
 * every page loads but its scripts and styles answer 403 - the 4xx alarm should roll it back.
 * The manifest lists only what was uploaded, so release:activate accepts the release.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { manifestKey, ReleaseManifest, releasePrefix } from '../lambda/shared/releases.js';
import type { BuiltRelease } from './build-release.js';
import { changeContext } from './lib/ci.js';
import { log, parseCli, run } from './lib/cli.js';
import { describeFiles } from './lib/manifest.js';
import { DIST_DIR, RELEASE_FILE } from './lib/paths.js';
import { requireFrontendOutputs } from './lib/stack.js';

const s3 = new S3Client({});
const UPLOAD_CONCURRENCY = 8;
const BREAKS = ['missing-assets'];

run(async () => {
  const { config, values } = parseCli(['break']);
  if (values.break && !BREAKS.includes(values.break)) {
    throw new Error(`--break must be one of ${BREAKS.join(', ')}, got "${values.break}"`);
  }
  const release: BuiltRelease = JSON.parse(await readFile(RELEASE_FILE, 'utf8').catch(() => {
    throw new Error('release.json not found - run npm run release:build first');
  }));
  if (release.env !== config.envName) {
    throw new Error(`dist/ holds a ${release.env} build, not ${config.envName} - rebuild with --env ${config.envName}`);
  }
  const outputs = await requireFrontendOutputs(config);
  const prefix = releasePrefix(release.releaseId);

  const existing = await s3.send(new ListObjectsV2Command({ Bucket: outputs.SiteBucketName, Prefix: `${prefix}/`, MaxKeys: 1 }));
  if (existing.KeyCount) throw new Error(`s3://${outputs.SiteBucketName}/${prefix}/ already exists - releases are never overwritten`);

  const built = await describeFiles(DIST_DIR);
  const files = values.break === 'missing-assets' ? built.filter((f) => !f.path.startsWith('assets/')) : built;
  if (values.break) log(`BROKEN ON PURPOSE (${values.break}): leaving out ${built.length - files.length} of ${built.length} files`);
  const queue = [...files];
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      await s3.send(new PutObjectCommand({
        Bucket: outputs.SiteBucketName,
        Key: `${prefix}/${file.path}`,
        Body: await readFile(path.join(DIST_DIR, file.path)),
        ContentType: file.contentType,
        CacheControl: file.cacheControl,
        ChecksumSHA256: Buffer.from(file.sha256, 'hex').toString('base64'),
      }));
    }
  }));
  log(`Uploaded ${files.length} files to s3://${outputs.SiteBucketName}/${prefix}/`);

  const { source: _source, ...context } = await changeContext();
  const manifest: ReleaseManifest = {
    releaseId: release.releaseId,
    frontendName: config.frontendName,
    env: config.envName,
    builtAt: release.builtAt,
    ...context,
    apiUrl: release.apiUrl,
    userPoolId: release.userPoolId,
    userPoolClientId: release.userPoolClientId,
    broken: values.break,
    files,
  };
  const key = manifestKey(config.frontendName, release.releaseId);
  await s3.send(new PutObjectCommand({
    Bucket: outputs.DeploymentsBucketName,
    Key: key,
    Body: `${JSON.stringify(manifest, null, 2)}\n`,
    ContentType: 'application/json',
  }));
  log(`Stored the manifest at s3://${outputs.DeploymentsBucketName}/${key}`);
  log(`Activate it with: npm run release:activate -- --env ${config.envName} --release ${release.releaseId}`);
  process.stdout.write(`${release.releaseId}\n`);
});
