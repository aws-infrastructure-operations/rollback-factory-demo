// Switching a distribution's release: the part of deploy-aws-cloudfront/lambda/shared/releases.ts the
// rollback needs (the deploy scripts use the original). Keep the two in sync.
import {
  CloudFrontClient, CreateInvalidationCommand, GetDistributionConfigCommand, UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';

/** Release ids are UTC timestamps, e.g. 20261006T123005Z, or the placeholder `initial`. */
export const RELEASE_ID_PATTERN = /^(\d{8}T\d{6}Z|initial)$/;

export function assertReleaseId(releaseId: string) {
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error(`Release ids look like 20261006T123005Z, got "${releaseId}"`);
  }
}

export const originPathFor = (releaseId: string) => `/releases/${releaseId}`;

/** The release an origin path serves, or undefined if it isn't a release path. */
export function releaseIdFromOriginPath(originPath: string | undefined): string | undefined {
  const match = /^\/releases\/([^/]+)$/.exec(originPath ?? '');
  return match && RELEASE_ID_PATTERN.test(match[1]) ? match[1] : undefined;
}

export interface SwitchResult {
  previousReleaseId?: string;
  releaseId: string;
  changed: boolean;
  invalidationId: string;
}

export async function getLiveReleaseId(cloudfront: CloudFrontClient, distributionId: string) {
  const { DistributionConfig } = await cloudfront.send(new GetDistributionConfigCommand({ Id: distributionId }));
  return releaseIdFromOriginPath(DistributionConfig?.Origins?.Items?.[0]?.OriginPath);
}

/**
 * Points every origin of the distribution at the release (conditional on the ETag) and invalidates
 * the whole cache. The distribution then takes a few minutes to deploy.
 */
export async function switchRelease(
  cloudfront: CloudFrontClient,
  distributionId: string,
  releaseId: string,
  callerReference: string,
): Promise<SwitchResult> {
  assertReleaseId(releaseId);
  const { DistributionConfig: config, ETag } = await cloudfront.send(new GetDistributionConfigCommand({ Id: distributionId }));
  const origins = config?.Origins?.Items ?? [];
  if (!config || !origins.length) throw new Error(`Distribution ${distributionId} has no origins`);

  const previousReleaseId = releaseIdFromOriginPath(origins[0].OriginPath);
  const originPath = originPathFor(releaseId);
  const changed = origins.some((origin) => origin.OriginPath !== originPath);
  if (changed) {
    for (const origin of origins) origin.OriginPath = originPath;
    await cloudfront.send(new UpdateDistributionCommand({ Id: distributionId, IfMatch: ETag, DistributionConfig: config }));
  }
  const { Invalidation } = await cloudfront.send(new CreateInvalidationCommand({
    DistributionId: distributionId,
    InvalidationBatch: { CallerReference: callerReference, Paths: { Quantity: 1, Items: ['/*'] } },
  }));
  return { previousReleaseId, releaseId, changed, invalidationId: Invalidation!.Id! };
}
