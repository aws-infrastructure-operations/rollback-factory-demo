import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { GetObjectCommand, HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3';
import { EnvConfig } from '../../lib/config.js';
import {
  assertReleaseId, manifestKey, ReleaseManifest, releasePrefix, SwitchResult, switchRelease, waitForSwitch,
} from '../../lambda/shared/releases.js';
import { log } from './cli.js';
import { FrontendOutputs, Target, targetDistribution } from './stack.js';

const s3 = new S3Client({});
export const cloudfront = new CloudFrontClient({ region: 'us-east-1' });

export interface Activation extends SwitchResult {
  target: Target;
  siteUrl: string;
  /** With wait: seconds until the distribution was deployed / the invalidation completed. */
  deployedAfter?: number;
  completedAfter?: number;
}

export async function getManifest(config: EnvConfig, outputs: FrontendOutputs, releaseId: string): Promise<ReleaseManifest> {
  const key = manifestKey(config.frontendName, releaseId);
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: outputs.DeploymentsBucketName, Key: key }));
    return JSON.parse(await res.Body!.transformToString());
  } catch (err) {
    throw new Error(`No manifest for release ${releaseId} at s3://${outputs.DeploymentsBucketName}/${key} (${(err as Error).name})`);
  }
}

/**
 * Makes an uploaded release live on a distribution (`live` by default, or `integration`):
 * checks every file of its manifest is in the site bucket, points the origin path at it and
 * invalidates /*. With wait, also waits for both.
 */
export async function activateRelease(
  config: EnvConfig,
  outputs: FrontendOutputs,
  releaseId: string,
  { wait = false, target = 'live' as Target } = {},
): Promise<Activation> {
  const { name, distributionId, siteUrl } = targetDistribution(config, outputs, target);
  assertReleaseId(releaseId);
  const manifest = await getManifest(config, outputs, releaseId);

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

  const result = await switchRelease(cloudfront, distributionId, releaseId, `activate-${target}-${releaseId}-${Date.now()}`);
  log(result.changed
    ? `${name}: ${result.previousReleaseId ?? '(no release)'} -> ${releaseId}`
    : `${name} already serves ${releaseId}`);
  log(`Invalidation ${result.invalidationId} for /* created`);

  if (!wait) {
    log('The switch takes a few minutes to reach every edge location (use --wait to wait for it)');
    return { ...result, target, siteUrl };
  }
  log('Waiting for the distribution to deploy and the invalidation to complete...');
  const timings = await waitForSwitch(cloudfront, distributionId, result.invalidationId);
  log(`Distribution deployed after ${timings.deployedAfter.toFixed(0)} s, invalidation completed after ${timings.completedAfter.toFixed(0)} s`);
  return { ...result, target, siteUrl, ...timings };
}
