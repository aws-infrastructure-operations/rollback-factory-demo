/**
 * Makes an uploaded release live: checks that every file of its manifest is in the site
 * bucket, points the distribution's origin path at releases/<id> and invalidates /*.
 * With --wait it waits for the distribution to deploy and the invalidation to finish and
 * prints how long each took.
 *
 * Prints the result as JSON on stdout ({ releaseId, previousReleaseId, invalidationId, ... }).
 *
 * Usage: npx tsx scripts/activate-release.ts --env dev --release 20261006T123005Z [--wait]
 */
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { GetObjectCommand, HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3';
import {
  assertReleaseId, manifestKey, ReleaseManifest, releasePrefix, switchRelease, waitForSwitch,
} from '../lambda/shared/releases.js';
import { log, parseCli, run } from './lib/cli.js';
import { requireFrontendOutputs } from './lib/stack.js';

const s3 = new S3Client({});
const cloudfront = new CloudFrontClient({ region: 'us-east-1' });

run(async () => {
  const { config, values } = parseCli(['release'], ['wait']);
  const releaseId = values.release;
  if (!releaseId) throw new Error('Pass --release <id> (see npm run release:upload)');
  assertReleaseId(releaseId);
  const outputs = await requireFrontendOutputs(config);

  const key = manifestKey(config.frontendName, releaseId);
  const manifest: ReleaseManifest = await s3
    .send(new GetObjectCommand({ Bucket: outputs.DeploymentsBucketName, Key: key }))
    .then(async (res) => JSON.parse(await res.Body!.transformToString()))
    .catch((err) => {
      throw new Error(`No manifest for release ${releaseId} at s3://${outputs.DeploymentsBucketName}/${key} (${err.name})`);
    });

  const prefix = releasePrefix(releaseId);
  const problems = (await Promise.all(manifest.files.map(async (file) => {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: outputs.SiteBucketName, Key: `${prefix}/${file.path}` }));
      return head.ContentLength === file.size ? undefined : `${file.path}: ${head.ContentLength} bytes, manifest says ${file.size}`;
    } catch (err) {
      if (err instanceof NotFound) return `${file.path}: missing`;
      throw err;
    }
  }))).filter(Boolean);
  if (problems.length) {
    throw new Error(`Release ${releaseId} doesn't match its manifest:\n  ${problems.join('\n  ')}`);
  }

  const result = await switchRelease(cloudfront, outputs.DistributionId, releaseId, `activate-${releaseId}-${Date.now()}`);
  log(result.changed
    ? `${config.frontendName}: ${result.previousReleaseId ?? '(no release)'} -> ${releaseId}`
    : `${config.frontendName} already serves ${releaseId}`);
  log(`Invalidation ${result.invalidationId} for /* created`);

  let timings: { deployedAfter: number; completedAfter: number } | undefined;
  if (values.wait) {
    log('Waiting for the distribution to deploy and the invalidation to complete...');
    timings = await waitForSwitch(cloudfront, outputs.DistributionId, result.invalidationId);
    log(`Distribution deployed after ${timings.deployedAfter.toFixed(0)} s, invalidation completed after ${timings.completedAfter.toFixed(0)} s`);
  } else {
    log('The switch takes a few minutes to reach every edge location (use --wait to wait for it)');
  }
  process.stdout.write(`${JSON.stringify({ ...result, siteUrl: outputs.SiteUrl, ...timings })}\n`);
});
