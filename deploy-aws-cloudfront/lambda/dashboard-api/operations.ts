// Restores and alias moves run in the rollback service while the page follows them: the dashboard
// API invokes the service asynchronously with an operation id, and the page polls
// GET /api/operations/<id>, which reads that run's lines from the service's log group and turns
// them into a status, the steps done so far and a progress percentage.
import { CloudWatchLogsClient, FilterLogEventsCommand, type FilteredLogEvent } from '@aws-sdk/client-cloudwatch-logs';
import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';

export type OperationKind = 'apigateway-restore' | 'cloudfront-restore' | 'lambda-point-alias' | 'cloudformation-restore';

/** What each kind goes through, in order, and the log line that marks each step done. */
export const STEPS: Record<OperationKind, Array<{ label: string; marker: string }>> = {
  'apigateway-restore': [
    { label: 'Rollback service started', marker: 'START RequestId' },
    { label: 'Read the recorded OpenAPI export', marker: '"msg":"restoring"' },
    { label: 'Re-imported it into the API', marker: '"step":"spec-imported"' },
    { label: 'Redeployed the stage', marker: '"step":"stage-redeployed"' },
    { label: 'Recorded the restore', marker: '"msg":"restore complete"' },
  ],
  'cloudfront-restore': [
    { label: 'Rollback service started', marker: 'START RequestId' },
    { label: 'Found the recorded release', marker: '"msg":"restoring"' },
    { label: 'Switched the site origin and invalidated the cache', marker: '"step":"release-switched"' },
    { label: 'Recorded the restore', marker: '"msg":"restore complete"' },
  ],
  'lambda-point-alias': [
    { label: 'Rollback service started', marker: 'START RequestId' },
    { label: 'Synced the version archive', marker: '"step":"archive-synced"' },
    { label: 'Moved the alias', marker: '"step":"alias-moved"' },
    // live only: the other aliases skip these two
    { label: 'Restored $LATEST from the archived package', marker: '"step":"latest-restored"' },
    { label: 'Recorded the change', marker: '"step":"recorded"' },
  ],
  'cloudformation-restore': [
    { label: 'Rollback service started', marker: 'START RequestId' },
    { label: 'Read the archived template', marker: '"msg":"restoring"' },
    { label: 'Started the stack update', marker: '"step":"update-started"' },
    { label: 'CloudFormation updated the stack', marker: '"step":"stack-updated"' },
    { label: 'Recorded the restore', marker: '"msg":"restore complete"' },
  ],
};

const KINDS = Object.keys(STEPS) as OperationKind[];
const OPERATION_ID = /^([a-z0-9]+)\.(apigateway-restore|cloudfront-restore|lambda-point-alias|cloudformation-restore)\.(\d{13})\.([0-9a-f]{8})$/;

/** <env>.<kind>.<start ms>.<random>: all the page needs to follow the run. */
export function parseOperationId(id: string) {
  const match = OPERATION_ID.exec(id);
  return match ? { env: match[1], kind: match[2] as OperationKind, startedAt: Number(match[3]) } : undefined;
}

export const rollbackServiceLogGroup = (project: string, env: string) => `${project}-rollback-service-logs-${env}`;

/**
 * Starts the rollback service on `payload` without waiting (it never retries, retryAttempts 0) and
 * returns the operation id the page follows. The id is in the payload, which the service logs first.
 */
export async function startOperation(
  lambda: LambdaClient,
  service: string,
  kind: OperationKind,
  payload: Record<string, unknown>,
  now = Date.now(),
): Promise<string> {
  const env = /-rollback-service-([a-z0-9]+)$/.exec(service)?.[1];
  if (!env || !KINDS.includes(kind)) throw new Error(`Can't start ${kind} on ${service}`);
  const operationId = `${env}.${kind}.${now}.${crypto.randomUUID().slice(0, 8)}`;
  await lambda.send(new InvokeCommand({
    FunctionName: service,
    InvocationType: 'Event',
    Payload: new TextEncoder().encode(JSON.stringify({ ...payload, operationId })),
  }));
  return operationId;
}

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'skipped' | 'failed';

/** What GET /api/operations/<id> returns (app/src/api.ts has the same shape). */
export interface OperationView {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  /** 0..100 */
  progress: number;
  steps: Array<{ label: string; done: boolean }>;
  lines: Array<{ time: string; level: string; text: string }>;
  /** the rollback service's result, when it finished */
  result?: unknown;
  /** why it was skipped or failed */
  reason?: string;
  /** when the dashboard started it (ISO 8601, from the operation id) */
  startedAt: string;
  /** how long a run of this kind usually takes, for the page's ETA */
  estimate: Estimate;
}

/** The usual duration of a kind of run: the median of its recent runs, or a default without any. */
export interface Estimate {
  ms: number;
  from: 'history' | 'default';
  /** how many recent runs the median is of */
  runs: number;
}

/** Without history: what a run of each kind takes, roughly (the async start and log delivery included). */
export const DEFAULT_ESTIMATE_MS: Record<OperationKind, number> = {
  'apigateway-restore': 10_000,
  'cloudfront-restore': 8_000,
  // syncs the archive and restores $LATEST from S3
  'lambda-point-alias': 25_000,
  // CloudFormation updates every resource that differs
  'cloudformation-restore': 180_000,
};
/** Starting the run asynchronously and delivering its lines takes a little on top of its own duration. */
const OVERHEAD_MS = 2_500;
const HISTORY_DAYS = 7;
const HISTORY_RUNS = 20;
const ESTIMATE_TTL_MS = 5 * 60_000;
const estimates = new Map<string, { at: number; estimate: Estimate }>();

/**
 * The median duration of the last successful runs of `kind`: the rollback service's result lines
 * carry the operation id (with the kind) and durationMs. Cached for a few minutes per log group.
 */
export async function estimateFor(logs: CloudWatchLogsClient, logGroupName: string, kind: OperationKind, now = Date.now()): Promise<Estimate> {
  const key = `${logGroupName}|${kind}`;
  const cached = estimates.get(key);
  if (cached && now - cached.at < ESTIMATE_TTL_MS) return cached.estimate;

  const events = await filter(logs, logGroupName, `"durationMs" ".${kind}."`, now - HISTORY_DAYS * 24 * 3600_000);
  const durations = events.map((e) => {
    try {
      const parsed = JSON.parse(lineOf(e).text);
      const skipped = parsed.result?.action === 'skip' || parsed.result?.rolledBack === false;
      return parsed.msg === 'result' && !skipped && typeof parsed.durationMs === 'number' ? parsed.durationMs as number : undefined;
    } catch {
      return undefined;
    }
  }).filter((d): d is number => d !== undefined).slice(-HISTORY_RUNS).sort((a, b) => a - b);

  const estimate: Estimate = durations.length
    ? { ms: durations[Math.floor(durations.length / 2)] + OVERHEAD_MS, from: 'history', runs: durations.length }
    : { ms: DEFAULT_ESTIMATE_MS[kind], from: 'default', runs: 0 };
  estimates.set(key, { at: now, estimate });
  return estimate;
}

/** For the tests. */
export const clearEstimates = () => estimates.clear();

const REQUEST_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
/** A run that never logged anything by now is lost (the service's own timeout is 10 min, but it logs at once). */
const GIVE_UP_AFTER_MS = 5 * 60 * 1000;

async function filter(logs: CloudWatchLogsClient, logGroupName: string, pattern: string, startTime: number) {
  const events: FilteredLogEvent[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = await logs.send(new FilterLogEventsCommand({ logGroupName, filterPattern: pattern, startTime, nextToken }));
    events.push(...(result.events ?? []));
    nextToken = result.nextToken;
    if (!nextToken) break;
  }
  return events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

/**
 * One runtime line: "<time>\t<request id>\t<LEVEL>\t<message>" for the code's output, or
 * "START|END|REPORT RequestId: ..." for the runtime's own.
 */
function lineOf(event: FilteredLogEvent) {
  const message = (event.message ?? '').trimEnd();
  const time = new Date(event.timestamp ?? 0).toISOString();
  const parts = message.split('\t');
  if (parts.length >= 4 && REQUEST_ID.test(parts[1])) return { time, level: parts[2], text: parts.slice(3).join('\t') };
  return { time, level: 'RUNTIME', text: message.replace(/\t/g, '  ') };
}

/** The rollback service's result line, if the run got that far. */
function resultOf(lines: Array<{ text: string }>) {
  for (const { text } of lines) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.msg === 'result') return { result: parsed.result as any };
      if (parsed?.msg === 'failed') return { error: String(parsed.error) };
    } catch { /* not a JSON line */ }
  }
  return undefined;
}

export async function getOperation(
  logs: CloudWatchLogsClient,
  project: string,
  id: string,
  now = Date.now(),
): Promise<OperationView | undefined> {
  const parsed = parseOperationId(id);
  if (!parsed) return undefined;
  const logGroupName = rollbackServiceLogGroup(project, parsed.env);
  const startTime = parsed.startedAt - 60_000;
  const stepsOf = (texts: string[]) => STEPS[parsed.kind].map((s) => ({ label: s.label, done: texts.some((t) => t.includes(s.marker)) }));

  // the run's first line has the operation id (the service logs the event it got)
  const timing = {
    startedAt: new Date(parsed.startedAt).toISOString(),
    estimate: await estimateFor(logs, logGroupName, parsed.kind, now),
  };
  const [first] = await filter(logs, logGroupName, `"${id}"`, startTime);
  const requestId = first && REQUEST_ID.exec(first.message ?? '')?.[0];
  if (!requestId) {
    const lost = now - parsed.startedAt > GIVE_UP_AFTER_MS;
    return {
      id, kind: parsed.kind, status: lost ? 'failed' : 'queued', progress: lost ? 100 : 2,
      steps: stepsOf([]), lines: [], ...timing,
      ...(lost && { reason: 'The rollback service never logged this run. Check its log group.' }),
    };
  }

  const events = await filter(logs, logGroupName, `"${requestId}"`, startTime);
  const lines = events.map(lineOf);
  const texts = events.map((e) => e.message ?? '');
  const steps = stepsOf(texts);
  const finished = texts.some((t) => t.startsWith('REPORT RequestId'));
  const outcome = resultOf(lines);

  let status: OperationStatus = 'running';
  let reason: string | undefined;
  if (finished || outcome) {
    const result = outcome?.result;
    if (outcome?.error || !outcome || texts.some((t) => /Task timed out|Runtime\.|Invoke Error/.test(t))) {
      status = finished || outcome?.error ? 'failed' : 'running';
      reason = outcome?.error ?? (finished ? 'The rollback service stopped without a result (see the log).' : undefined);
    } else if (result?.action === 'skip' || result?.rolledBack === false) {
      status = 'skipped';
      reason = String(result.reason ?? 'The rollback service changed nothing.');
    } else {
      status = 'succeeded';
    }
  }
  const done = steps.filter((s) => s.done).length;
  const ended = status === 'succeeded' || status === 'skipped' || status === 'failed';
  return {
    id,
    kind: parsed.kind,
    status,
    progress: ended ? 100 : Math.max(5, Math.round((done / steps.length) * 95)),
    // an alias other than live skips two steps: they count as done once it succeeded
    steps: status === 'succeeded' ? steps.map((s) => ({ ...s, done: true })) : steps,
    lines,
    ...timing,
    ...(outcome?.result !== undefined && { result: outcome.result }),
    ...(reason && { reason }),
  };
}
