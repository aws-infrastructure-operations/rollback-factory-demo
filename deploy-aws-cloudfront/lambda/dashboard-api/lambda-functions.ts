// The region's Lambda functions for the dashboard: the list (with each function's aliases), one
// function's versions, aliases and configuration, and its last 24 hours of metrics. Read-only.
//
// The Lambda API returns environment variables with every configuration: only the fields named
// here are copied into a response, so they never reach the page.
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  LambdaClient, ListAliasesCommand, ListFunctionsCommand, ListVersionsByFunctionCommand,
  type AliasConfiguration, type FunctionConfiguration,
} from '@aws-sdk/client-lambda';
import { mapLimit } from './util.js';

/** What GET /api/lambda-functions returns per function (app/src/api.ts has the same shape). */
export interface LambdaFunctionSummary {
  name: string;
  arn: string;
  /** e.g. nodejs24.x, or 'Container image' */
  runtime: string;
  description?: string;
  aliases: string[];
  /** ISO 8601 */
  lastModified?: string;
}

/** What GET /api/lambda-functions/<name> returns. */
export interface LambdaFunctionDetails {
  name: string;
  arn: string;
  /** published versions, newest first, at most MAX_VERSIONS; each with the aliases that serve it */
  versions: Array<{ version: string; description?: string; publishedAt?: string; aliases: string[] }>;
  aliases: Array<{ name: string; version: string; description?: string; additionalVersions?: Record<string, number> }>;
  configuration: Array<{ label: string; value: string }>;
  /**
   * Functions registered for rollback only: the alias the rollback service watches. Their aliases can be
   * pointed at a version from the dashboard (POST .../point-alias); others are read-only.
   */
  managedAlias?: string;
}

/** What GET /api/lambda-functions/<name>/metrics returns: totals over the last 24 hours. */
export interface LambdaFunctionMetrics {
  from: string;
  to: string;
  invocations: number;
  errors: number;
  throttles: number;
  /** milliseconds, undefined without invocations */
  averageDuration?: number;
  maxDuration?: number;
  maxConcurrency?: number;
}

export const MAX_VERSIONS = 25;
/** At most this many ListAliases calls at a time, against the Lambda control plane's rate limits. */
const ALIAS_CONCURRENCY = 4;

/** Function names: letters, digits, '-' and '_', up to 64 characters (no ARNs or qualifiers here). */
export const isFunctionName = (name: string) => /^[A-Za-z0-9_-]{1,64}$/.test(name);

/** Lambda dates look like 2026-10-06T13:21:00.000+0000. */
export const lambdaDate = (value?: string) => {
  if (!value) return undefined;
  const date = new Date(value.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const runtimeOf = (fn: FunctionConfiguration) => fn.Runtime ?? (fn.PackageType === 'Image' ? 'Container image' : 'unknown');

export async function listLambdaFunctions(client: LambdaClient): Promise<LambdaFunctionSummary[]> {
  const functions: FunctionConfiguration[] = [];
  let marker: string | undefined;
  do {
    const page = await client.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    functions.push(...(page.Functions ?? []));
    marker = page.NextMarker;
  } while (marker);

  const summaries = await mapLimit(functions, ALIAS_CONCURRENCY, async (fn) => ({
    name: fn.FunctionName!,
    arn: fn.FunctionArn!,
    runtime: runtimeOf(fn),
    ...(fn.Description && { description: fn.Description }),
    aliases: (await listAliases(client, fn.FunctionName!)).map((a) => a.Name!).sort(),
    ...(lambdaDate(fn.LastModified) && { lastModified: lambdaDate(fn.LastModified) }),
  }));
  // most recently changed first
  return summaries.sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? '') || a.name.localeCompare(b.name));
}

async function listAliases(client: LambdaClient, functionName: string) {
  const aliases: AliasConfiguration[] = [];
  let marker: string | undefined;
  do {
    const page = await client.send(new ListAliasesCommand({ FunctionName: functionName, Marker: marker }));
    aliases.push(...(page.Aliases ?? []));
    marker = page.NextMarker;
  } while (marker);
  return aliases;
}

/** Undefined when the function doesn't exist. */
export async function getLambdaFunctionDetails(client: LambdaClient, name: string): Promise<LambdaFunctionDetails | undefined> {
  let versions: FunctionConfiguration[];
  let aliasItems: AliasConfiguration[];
  try {
    [versions, aliasItems] = await Promise.all([listVersions(client, name), listAliases(client, name)]);
  } catch (err) {
    if ((err as Error).name === 'ResourceNotFoundException') return undefined;
    throw err;
  }
  const latest = versions.find((v) => v.Version === '$LATEST') ?? versions[0];
  const aliases = aliasItems.map((a) => ({
    name: a.Name!,
    version: a.FunctionVersion!,
    ...(a.Description && { description: a.Description }),
    ...(a.RoutingConfig?.AdditionalVersionWeights && { additionalVersions: a.RoutingConfig.AdditionalVersionWeights }),
  })).sort((a, b) => a.name.localeCompare(b.name));

  const published = versions
    .filter((v) => v.Version !== '$LATEST')
    .sort((a, b) => Number(b.Version) - Number(a.Version))
    .slice(0, MAX_VERSIONS);
  return {
    name,
    arn: latest?.FunctionArn?.replace(/:\$LATEST$/, '') ?? name,
    versions: published.map((v) => ({
      version: v.Version!,
      ...(v.Description && { description: v.Description }),
      ...(lambdaDate(v.LastModified) && { publishedAt: lambdaDate(v.LastModified) }),
      // an alias serves a version as its main version, or as the weighted extra one
      aliases: aliases.filter((a) => a.version === v.Version || a.additionalVersions?.[v.Version!] !== undefined).map((a) => a.name),
    })),
    aliases,
    configuration: latest ? configurationOf(latest) : [],
  };
}

async function listVersions(client: LambdaClient, functionName: string) {
  const versions: FunctionConfiguration[] = [];
  let marker: string | undefined;
  do {
    const page = await client.send(new ListVersionsByFunctionCommand({ FunctionName: functionName, Marker: marker, MaxItems: 50 }));
    versions.push(...(page.Versions ?? []));
    marker = page.NextMarker;
  } while (marker);
  return versions;
}

const withUnit = (value: number | undefined, unit: string) => (value ? `${value} ${unit}` : undefined);

/** $LATEST's settings. Named fields only: never Environment, which can hold secrets. */
function configurationOf(fn: FunctionConfiguration) {
  const rows: Array<[string, string | undefined]> = [
    ['Description', fn.Description],
    ['Runtime', runtimeOf(fn)],
    ['Handler', fn.Handler],
    ['Architecture', fn.Architectures?.join(', ')],
    ['Memory', withUnit(fn.MemorySize, 'MB')],
    ['Timeout', withUnit(fn.Timeout, 's')],
    ['Ephemeral storage', withUnit(fn.EphemeralStorage?.Size, 'MB')],
    ['Code size', withUnit(fn.CodeSize && Number((fn.CodeSize / 1024 / 1024).toFixed(2)), 'MB')],
    ['Layers', fn.Layers?.length ? String(fn.Layers.length) : undefined],
    ['Tracing', fn.TracingConfig?.Mode],
    ['State', [fn.State, fn.LastUpdateStatus && `last update ${fn.LastUpdateStatus}`].filter(Boolean).join(', ')],
    ['Last modified', lambdaDate(fn.LastModified)],
  ];
  return rows.filter(([, value]) => value).map(([label, value]) => ({ label, value: value! }));
}

/** Totals over the last 24 hours, from the function's AWS/Lambda metrics (all versions and aliases). */
export async function getLambdaFunctionMetrics(client: CloudWatchClient, name: string, now = new Date()): Promise<LambdaFunctionMetrics> {
  const to = now;
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  const period = 24 * 60 * 60;
  const query = (id: string, metric: string, stat: string) => ({
    Id: id,
    MetricStat: {
      Metric: { Namespace: 'AWS/Lambda', MetricName: metric, Dimensions: [{ Name: 'FunctionName', Value: name }] },
      Period: period,
      Stat: stat,
    },
  });
  const { MetricDataResults = [] } = await client.send(new GetMetricDataCommand({
    StartTime: from,
    EndTime: to,
    MetricDataQueries: [
      query('invocations', 'Invocations', 'Sum'),
      query('errors', 'Errors', 'Sum'),
      query('throttles', 'Throttles', 'Sum'),
      query('avgDuration', 'Duration', 'Average'),
      query('maxDuration', 'Duration', 'Maximum'),
      query('maxConcurrency', 'ConcurrentExecutions', 'Maximum'),
    ],
  }));
  // one 24 h period, though CloudWatch can split it in two at a period boundary
  const values = (id: string) => MetricDataResults.find((r) => r.Id === id)?.Values ?? [];
  const sum = (id: string) => values(id).reduce((total, v) => total + v, 0);
  const max = (id: string) => (values(id).length ? Math.max(...values(id)) : undefined);
  const invocations = sum('invocations');
  const durations = values('avgDuration');
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    invocations,
    errors: sum('errors'),
    throttles: sum('throttles'),
    ...(invocations > 0 && durations.length && { averageDuration: Math.round(durations.reduce((t, v) => t + v, 0) / durations.length) }),
    ...(max('maxDuration') !== undefined && { maxDuration: Math.round(max('maxDuration')!) }),
    ...(max('maxConcurrency') !== undefined && { maxConcurrency: max('maxConcurrency') }),
  };
}
