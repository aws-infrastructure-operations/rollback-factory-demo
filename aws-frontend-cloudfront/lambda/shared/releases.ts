// Releases: naming, manifest shape, and switching the distribution's origin path.
// Shared by the release scripts and the rollback Lambda (FE-08), so no filesystem access here.
import {
  CloudFrontClient, CreateInvalidationCommand, GetDistributionConfigCommand, UpdateDistributionCommand,
  waitUntilDistributionDeployed, waitUntilInvalidationCompleted,
} from '@aws-sdk/client-cloudfront';

/** Placeholder release a fresh stack serves until the first real release is activated. */
export const INITIAL_RELEASE_ID = 'initial';
/** Release ids are UTC timestamps, e.g. 20261006T123005Z, or the placeholder `initial`. */
export const RELEASE_ID_PATTERN = /^(\d{8}T\d{6}Z|initial)$/;

/** 2026-10-06T12:30:05.123Z -> 20261006T123005Z (same format as the API's deployment keys). */
export const releaseIdFor = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function assertReleaseId(releaseId: string) {
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error(`Release ids look like 20261006T123005Z, got "${releaseId}"`);
  }
}

/** S3 prefix of a release in the site bucket (no trailing slash). */
export const releasePrefix = (releaseId: string) => `releases/${releaseId}`;
export const originPathFor = (releaseId: string) => `/${releasePrefix(releaseId)}`;

/** The release an origin path serves, or undefined if it isn't a release path. */
export function releaseIdFromOriginPath(originPath: string | undefined): string | undefined {
  const match = /^\/releases\/([^/]+)$/.exec(originPath ?? '');
  return match && RELEASE_ID_PATTERN.test(match[1]) ? match[1] : undefined;
}

/** Key of a release's manifest in the deployments bucket: <frontendName>/<releaseId>/manifest.json */
export const manifestKey = (frontendName: string, releaseId: string) => `${frontendName}/${releaseId}/manifest.json`;

// --- Manifest -------------------------------------------------------------------

export interface ManifestFile {
  /** Path inside the release, e.g. assets/app-Bbx963EB.js */
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  cacheControl: string;
}

export interface ReleaseManifest {
  releaseId: string;
  frontendName: string;
  env: string;
  builtAt: string;
  commit?: string;
  actor?: string;
  runUrl?: string;
  /** What the release was built against (from the api-user stack outputs). */
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  files: ManifestFile[];
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export const contentTypeFor = (filePath: string) =>
  CONTENT_TYPES[filePath.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';

/**
 * HTML is revalidated on every request, so an activation or rollback shows up as soon as
 * the invalidation is done. Everything else has a content hash in its name (Vite) and is
 * cached for a year.
 */
export const cacheControlFor = (filePath: string) =>
  filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable';

// --- Switching releases -------------------------------------------------------

export interface SwitchResult {
  /** The release the distribution served before, undefined if its origin path wasn't a release. */
  previousReleaseId?: string;
  releaseId: string;
  /** False when the distribution already served the release; the cache is invalidated anyway. */
  changed: boolean;
  invalidationId: string;
}

export async function getLiveReleaseId(cloudfront: CloudFrontClient, distributionId: string) {
  const { DistributionConfig } = await cloudfront.send(new GetDistributionConfigCommand({ Id: distributionId }));
  return releaseIdFromOriginPath(DistributionConfig?.Origins?.Items?.[0]?.OriginPath);
}

/**
 * Points every origin of the distribution at the release (there is one: the site bucket)
 * and invalidates the whole cache. The distribution then takes a few minutes to deploy.
 */
export async function switchRelease(
  cloudfront: CloudFrontClient,
  distributionId: string,
  releaseId: string,
  callerReference: string,
): Promise<SwitchResult> {
  assertReleaseId(releaseId);
  const { DistributionConfig: config, ETag } = await cloudfront.send(
    new GetDistributionConfigCommand({ Id: distributionId }),
  );
  const origins = config?.Origins?.Items ?? [];
  if (!config || !origins.length) throw new Error(`Distribution ${distributionId} has no origins`);

  const previousReleaseId = releaseIdFromOriginPath(origins[0].OriginPath);
  const originPath = originPathFor(releaseId);
  const changed = origins.some((origin) => origin.OriginPath !== originPath);
  if (changed) {
    for (const origin of origins) origin.OriginPath = originPath;
    // IfMatch: fails instead of overwriting if someone else changed the distribution meanwhile
    await cloudfront.send(new UpdateDistributionCommand({ Id: distributionId, IfMatch: ETag, DistributionConfig: config }));
  }

  const { Invalidation } = await cloudfront.send(new CreateInvalidationCommand({
    DistributionId: distributionId,
    InvalidationBatch: { CallerReference: callerReference, Paths: { Quantity: 1, Items: ['/*'] } },
  }));
  return { previousReleaseId, releaseId, changed, invalidationId: Invalidation!.Id! };
}

/** Waits until the distribution is deployed and the invalidation completed; returns both durations in seconds. */
export async function waitForSwitch(
  cloudfront: CloudFrontClient,
  distributionId: string,
  invalidationId: string,
  maxWaitTime = 1800,
) {
  const started = Date.now();
  await waitUntilDistributionDeployed({ client: cloudfront, maxWaitTime }, { Id: distributionId });
  const deployedAfter = (Date.now() - started) / 1000;
  await waitUntilInvalidationCompleted(
    { client: cloudfront, maxWaitTime },
    { DistributionId: distributionId, Id: invalidationId },
  );
  return { deployedAfter, completedAfter: (Date.now() - started) / 1000 };
}
