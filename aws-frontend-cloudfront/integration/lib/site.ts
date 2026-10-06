import { S3Client } from '@aws-sdk/client-s3';
import { getConfig } from '../../lib/config.js';
import { getLiveReleaseId, ReleaseManifest } from '../../lambda/shared/releases.js';
import { cloudfront, getManifest } from '../../scripts/lib/activate.js';
import { FrontendOutputs, requireFrontendOutputs } from '../../scripts/lib/stack.js';

export const config = getConfig(process.env.FRONTEND_ENV ?? 'dev');

export interface LiveSite {
  outputs: FrontendOutputs;
  siteUrl: string;
  /** Region of the main stack (and its buckets). */
  region: string;
  releaseId: string;
  manifest: ReleaseManifest;
}

/**
 * The deployed site of FRONTEND_ENV and the release it serves. With FRONTEND_RELEASE set
 * (CI, right after activating), fails unless that release is the live one.
 */
export async function liveSite(): Promise<LiveSite> {
  const outputs = await requireFrontendOutputs(config);
  const releaseId = await getLiveReleaseId(cloudfront, outputs.DistributionId);
  if (!releaseId || releaseId === 'initial') {
    throw new Error(`${config.frontendName} serves ${releaseId ?? 'no release'} - activate a release before testing`);
  }
  const expected = process.env.FRONTEND_RELEASE;
  if (expected && expected !== releaseId) {
    throw new Error(`${config.frontendName} serves release ${releaseId}, expected ${expected}`);
  }
  return {
    outputs,
    siteUrl: outputs.SiteUrl.replace(/\/$/, ''),
    region: await new S3Client({}).config.region(),
    releaseId,
    manifest: await getManifest(config, outputs, releaseId),
  };
}
