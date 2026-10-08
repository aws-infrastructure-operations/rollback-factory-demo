// The account's CloudFront distributions for the dashboard: the list, one distribution's release
// history (for the ones this project deploys), configuration and invalidations, and its last 24
// hours of metrics; and restoring a recorded release, which the rollback service carries out.
//
// GetDistribution returns the whole config, origin custom headers included (often a shared
// secret with the origin): only the fields named here are copied into a response.
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  CloudFrontClient, GetDistributionCommand, GetInvalidationCommand, ListDistributionsCommand, ListInvalidationsCommand,
  type DistributionSummary, type Origin,
} from '@aws-sdk/client-cloudfront';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DeploymentRecord } from '../shared/deployments.js';
import { releaseIdFromOriginPath, releaseOrigins } from '../shared/releases.js';
import { mapLimit } from './util.js';
import { startOperation } from './operations.js';

/** What GET /api/cloudfront-distributions returns per distribution (app/src/api.ts has the same shape). */
export interface DistributionSummaryView {
  id: string;
  /** the comment (this project names its distributions there), else the id */
  name: string;
  domain: string;
  aliases: string[];
  /** Deployed or InProgress */
  status: string;
  enabled: boolean;
  /** the release the site origin serves, for distributions this project deploys */
  releaseId?: string;
  /** ISO 8601 */
  lastModified?: string;
}

/** What GET /api/cloudfront-distributions/<id> returns. */
export interface DistributionDetails extends DistributionSummaryView {
  /** recorded activations, restores and rollbacks, newest first; empty for distributions deployed elsewhere */
  deployments: Array<{
    releaseId: string;
    deployedAt: string;
    source: string;
    actor?: string;
    commit?: string;
    description?: string;
    current: boolean;
    verified: boolean;
    rolledBack: boolean;
    stableFor?: string;
  }>;
  /** whether the history table exists for this distribution (see deploymentsTableFor) */
  tracked: boolean;
  configuration: Array<{ label: string; value: string }>;
}

/** What GET /api/cloudfront-distributions/<id>/invalidations returns: the latest ones. */
export interface DistributionInvalidation {
  id: string;
  status: string;
  createdAt?: string;
  paths: string[];
}

/** What GET /api/cloudfront-distributions/<id>/metrics returns: the last 24 hours. */
export interface DistributionMetrics {
  from: string;
  to: string;
  requests: number;
  bytesDownloaded: number;
  /** percentages, averaged over the period's data points; undefined without traffic */
  error4xxRate?: number;
  error5xxRate?: number;
}

export const MAX_DEPLOYMENTS = 25;
export const MAX_INVALIDATIONS = 10;

/** Distribution ids: uppercase letters and digits. */
export const isDistributionId = (id: string) => /^[A-Z0-9]{10,20}$/.test(id);

/**
 * The deployments table of a distribution this project deploys: frontend-user-<env> keeps its history
 * in <project>-frontend-deployments-<env>. Any other distribution (integration ones included) has none.
 */
export function deploymentsTableFor(comment: string | undefined, project: string): string | undefined {
  const env = /^frontend-user-([a-z0-9]+)$/.exec(comment ?? '')?.[1];
  return env && `${project}-frontend-deployments-${env}`;
}

const iso = (date?: Date) => date?.toISOString();

function summarize(d: {
  Id?: string; DomainName?: string; Status?: string; LastModifiedTime?: Date; Comment?: string; Enabled?: boolean;
  Aliases?: { Items?: string[] }; Origins?: { Items?: Origin[] };
}): DistributionSummaryView {
  const releaseId = releaseIdFromOriginPath(releaseOrigins(d.Origins?.Items ?? [])[0]?.OriginPath);
  return {
    id: d.Id!,
    name: d.Comment || d.Id!,
    domain: d.DomainName!,
    aliases: d.Aliases?.Items ?? [],
    status: d.Status ?? 'unknown',
    enabled: d.Enabled ?? false,
    ...(releaseId && { releaseId }),
    ...(d.LastModifiedTime && { lastModified: iso(d.LastModifiedTime) }),
  };
}

export async function listDistributions(client: CloudFrontClient): Promise<DistributionSummaryView[]> {
  const items: DistributionSummary[] = [];
  let marker: string | undefined;
  do {
    const { DistributionList: page } = await client.send(new ListDistributionsCommand({ Marker: marker, MaxItems: 100 }));
    items.push(...(page?.Items ?? []));
    marker = page?.IsTruncated ? page.NextMarker : undefined;
  } while (marker);
  // most recently changed first
  return items.map(summarize)
    .sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? '') || a.name.localeCompare(b.name));
}

/** Undefined when the distribution doesn't exist. */
export async function getDistributionDetails(
  cloudfront: CloudFrontClient,
  dynamo: DynamoDBDocumentClient,
  id: string,
  project: string,
): Promise<DistributionDetails | undefined> {
  let distribution;
  try {
    ({ Distribution: distribution } = await cloudfront.send(new GetDistributionCommand({ Id: id })));
  } catch (err) {
    if ((err as Error).name === 'NoSuchDistribution') return undefined;
    throw err;
  }
  if (!distribution) return undefined;
  const config = distribution.DistributionConfig!;
  const summary = summarize({ ...distribution, ...config });
  const table = deploymentsTableFor(config.Comment, project);
  const records = table ? await readDeployments(dynamo, table, config.Comment!, id) : undefined;

  const origins = config.Origins?.Items ?? [];
  const rows: Array<[string, string | undefined]> = [
    ['Domain name', distribution.DomainName],
    ['Alternate domains', config.Aliases?.Items?.join(', ')],
    ['Enabled', config.Enabled ? 'yes' : 'no'],
    ['Release', summary.releaseId],
    // id, domain and path only: never custom headers
    ...origins.map((o, i): [string, string] => [
      origins.length > 1 ? `Origin ${i + 1}` : 'Origin',
      `${o.DomainName}${o.OriginPath ?? ''}${o.DomainName?.includes('.lambda-url.') ? ' (dashboard API)' : ''}`,
    ]),
    ['Path patterns', config.CacheBehaviors?.Items?.map((b) => b.PathPattern).join(', ')],
    ['Default root object', config.DefaultRootObject],
    ['Price class', config.PriceClass],
    ['HTTP versions', config.HttpVersion],
    ['IPv6', config.IsIPV6Enabled ? 'enabled' : 'disabled'],
    ['Viewer protocol', config.DefaultCacheBehavior?.ViewerProtocolPolicy],
    ['Web ACL', config.WebACLId ? 'attached' : undefined],
    ['Last modified', iso(distribution.LastModifiedTime)],
  ];
  return {
    ...summary,
    tracked: records !== undefined,
    deployments: (records ?? []).map((r) => ({
      releaseId: r.releaseId,
      deployedAt: r.deployedAt,
      source: r.source,
      ...(r.actor && { actor: r.actor }),
      ...(r.commit && { commit: r.commit }),
      ...(r.description && { description: r.description }),
      current: r.current === true,
      verified: r.verifiedAt !== undefined,
      rolledBack: r.rolledBackAt !== undefined || r.stable === false,
      ...(r.stableForHumanReadable && { stableFor: r.stableForHumanReadable }),
    })),
    configuration: rows.filter(([, value]) => value).map(([label, value]) => ({ label, value: value! })),
  };
}

/** Undefined when the table doesn't exist (e.g. that environment isn't deployed). */
async function readDeployments(dynamo: DynamoDBDocumentClient, table: string, frontendName: string, distributionId: string) {
  try {
    const { Items = [] } = await dynamo.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'frontendName = :name',
      ExpressionAttributeValues: { ':name': frontendName },
      ScanIndexForward: false,
      Limit: MAX_DEPLOYMENTS,
    }));
    // a recreated distribution starts a new history under the same name
    return (Items as DeploymentRecord[]).filter((r) => r.distributionId === distributionId);
  } catch (err) {
    if ((err as Error).name === 'ResourceNotFoundException') return undefined;
    throw err;
  }
}

/** The latest invalidations with their paths (GetInvalidation per item: the list has no paths). */
export async function listInvalidations(client: CloudFrontClient, distributionId: string): Promise<DistributionInvalidation[]> {
  const { InvalidationList } = await client.send(new ListInvalidationsCommand({ DistributionId: distributionId, MaxItems: MAX_INVALIDATIONS }));
  return mapLimit(InvalidationList?.Items ?? [], 4, async (item) => {
    const { Invalidation } = await client.send(new GetInvalidationCommand({ DistributionId: distributionId, Id: item.Id }));
    return {
      id: item.Id!,
      status: item.Status ?? 'unknown',
      ...(item.CreateTime && { createdAt: iso(item.CreateTime) }),
      paths: Invalidation?.InvalidationBatch?.Paths?.Items ?? [],
    };
  });
}

/** CloudFront publishes its metrics in us-east-1 only, with Region=Global: `client` must be there. */
export async function getDistributionMetrics(client: CloudWatchClient, distributionId: string, now = new Date()): Promise<DistributionMetrics> {
  const to = now;
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  const query = (id: string, metric: string, stat: string, period: number) => ({
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/CloudFront',
        MetricName: metric,
        Dimensions: [{ Name: 'DistributionId', Value: distributionId }, { Name: 'Region', Value: 'Global' }],
      },
      Period: period,
      Stat: stat,
    },
  });
  const day = 24 * 60 * 60;
  const { MetricDataResults = [] } = await client.send(new GetMetricDataCommand({
    StartTime: from,
    EndTime: to,
    MetricDataQueries: [
      query('requests', 'Requests', 'Sum', day),
      query('bytes', 'BytesDownloaded', 'Sum', day),
      // hourly, so the average is over the hours with traffic, not one point
      query('rate4xx', '4xxErrorRate', 'Average', 3600),
      query('rate5xx', '5xxErrorRate', 'Average', 3600),
    ],
  }));
  const values = (id: string) => MetricDataResults.find((r) => r.Id === id)?.Values ?? [];
  const sum = (id: string) => values(id).reduce((total, v) => total + v, 0);
  const average = (id: string) => {
    const v = values(id);
    return v.length ? Math.round((v.reduce((t, x) => t + x, 0) / v.length) * 100) / 100 : undefined;
  };
  const requests = sum('requests');
  const rate4xx = requests ? average('rate4xx') : undefined;
  const rate5xx = requests ? average('rate5xx') : undefined;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    requests,
    bytesDownloaded: sum('bytes'),
    ...(rate4xx !== undefined && { error4xxRate: rate4xx }),
    ...(rate5xx !== undefined && { error5xxRate: rate5xx }),
  };
}

// --- Restore (the Restore button) ---------------------------------------------------------------

export type ReleaseRestoreResult =
  | { ok: true; operationId: string }
  | { ok: false; status: 400 | 404 | 409; message: string };

/** The rollback service of a frontend-user-<env> distribution's environment; none for any other. */
export function rollbackServiceForDistribution(comment: string | undefined, project: string): string | undefined {
  const env = /^frontend-user-([a-z0-9]+)$/.exec(comment ?? '')?.[1];
  return env && `${project}-rollback-service-${env}`;
}

/**
 * Makes the distribution serve the release recorded at `deployedAt` again: the environment's
 * rollback service switches the site origin, invalidates /* and records a "restore" (not verified
 * until the integration tests pass again). Synchronous, so the page can show the outcome; the
 * distribution itself takes a few minutes to deploy.
 */
export async function restoreRelease(
  cloudfront: CloudFrontClient,
  dynamo: DynamoDBDocumentClient,
  lambda: LambdaClient,
  project: string,
  distributionId: string,
  /** actor: who asked, dashboard:<email> (default dashboard) */
  req: { deployedAt: string; reason?: string; actor?: string },
): Promise<ReleaseRestoreResult> {
  let distribution;
  try {
    ({ Distribution: distribution } = await cloudfront.send(new GetDistributionCommand({ Id: distributionId })));
  } catch (err) {
    if ((err as Error).name === 'NoSuchDistribution') return { ok: false, status: 404, message: `No distribution ${distributionId}` };
    throw err;
  }
  const comment = distribution?.DistributionConfig?.Comment;
  const table = deploymentsTableFor(comment, project);
  const service = rollbackServiceForDistribution(comment, project);
  if (!table || !service) {
    return { ok: false, status: 400, message: `${comment || distributionId} has no release history: nothing to restore` };
  }

  const records = (await readDeployments(dynamo, table, comment!, distributionId)) ?? [];
  const record = records.find((r) => r.deployedAt === req.deployedAt);
  if (!record) return { ok: false, status: 404, message: `No release of ${comment} recorded at ${req.deployedAt}` };
  const live = summarize({ ...distribution, ...distribution!.DistributionConfig }).releaseId;
  if (record.releaseId === live) return { ok: false, status: 409, message: `${comment} already serves release ${record.releaseId}` };

  // the page follows the run in a popup (GET /api/operations/<id>)
  const operationId = await startOperation(lambda, service, 'cloudfront-restore', { type: 'restore', manager: 'cloudfront', deployedAt: record.deployedAt, actor: req.actor ?? 'dashboard', reason: req.reason });
  return { ok: true, operationId };
}
