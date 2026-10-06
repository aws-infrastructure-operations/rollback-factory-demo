import { S3Client } from '@aws-sdk/client-s3';
import { getConfig } from '../../lib/config.js';
import { getLiveReleaseId, ReleaseManifest } from '../../lambda/shared/releases.js';
import { cloudfront, getManifest } from '../../scripts/lib/activate.js';
import { FrontendOutputs, parseTarget, requireFrontendOutputs, Target, targetDistribution } from '../../scripts/lib/stack.js';

export const config = getConfig(process.env.FRONTEND_ENV ?? 'dev');
/** FRONTEND_TARGET=integration tests frontend-user-<env>-integration (CI, before promoting). */
export const target: Target = parseTarget(process.env.FRONTEND_TARGET || undefined);

export interface LiveSite {
  outputs: FrontendOutputs;
  /** The tested distribution's comment, frontend-user-<env>[-integration]. */
  name: string;
  siteUrl: string;
  /** Region of the main stack (and its buckets). */
  region: string;
  releaseId: string;
  manifest: ReleaseManifest;
}

/**
 * The deployed site of FRONTEND_ENV (on the FRONTEND_TARGET distribution) and the release it
 * serves. With FRONTEND_RELEASE set (CI, right after activating), fails unless that release is
 * the one served.
 */
export async function liveSite(): Promise<LiveSite> {
  const outputs = await requireFrontendOutputs(config);
  const { name, distributionId, siteUrl } = targetDistribution(config, outputs, target);
  const releaseId = await getLiveReleaseId(cloudfront, distributionId);
  if (!releaseId || releaseId === 'initial') {
    throw new Error(`${name} serves ${releaseId ?? 'no release'} - activate a release before testing`);
  }
  const expected = process.env.FRONTEND_RELEASE;
  if (expected && expected !== releaseId) {
    throw new Error(`${name} serves release ${releaseId}, expected ${expected}`);
  }
  return {
    outputs,
    name,
    siteUrl: siteUrl.replace(/\/$/, ''),
    region: await new S3Client({}).config.region(),
    releaseId,
    manifest: await getManifest(config, outputs, releaseId),
  };
}
