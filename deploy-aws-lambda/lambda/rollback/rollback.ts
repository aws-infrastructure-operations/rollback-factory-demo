// Rollback system for registered Lambda functions (see rollback-config.json).
//
// Invoked by:
//   - SNS, when a registered CloudWatch alarm goes into ALARM;
//   - EventBridge every few minutes ({ type: 'scheduled-check' }): syncs metadata, marks the live
//     version stable when all its alarms are OK, and re-checks alarms still in ALARM (CloudWatch
//     only notifies on state changes);
//   - the deploy workflow after promoting a version to live ({ type: 'sync' }).
//
// Sync keeps a DynamoDB record of every published version and copies each version's package to S3
// as <fn>/<fn>-<version>.zip. A rollback moves the alias to the previous version that was live and
// restores $LATEST from its zip. Nothing is rebuilt.
//
// All AWS clients come in through `deps`, so the logic can be unit tested without AWS.
import {
  CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand, type MetricAlarm,
} from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import {
  GetAliasCommand, GetFunctionCommand, LambdaClient, ListVersionsByFunctionCommand, UpdateAliasCommand,
  UpdateFunctionCodeCommand,
} from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Registration } from './registry.js';
import {
  ArchivedVersion, CurrentState, findRollbackTarget, getCurrent, getVersionItem, markLive, queryVersions,
} from './store.js';
import { BOOL, CURRENT_SK, N, S, formatDuration, isConditionFailure, s3Key, skip, versionSk } from './util.js';

export interface ScopedClients {
  lambda: LambdaClient;
  s3: S3Client;
  ddb: DynamoDBClient;
}

export interface Deps {
  cloudwatch: CloudWatchClient;
  /** Clients whose credentials can touch only this one function (see scoped.ts). */
  scopedClients: (functionName: string) => Promise<ScopedClients>;
  /** Downloads a version's package from Lambda's presigned URL. */
  fetch: typeof fetch;
  /** Waits until a function code update has finished. */
  waitForUpdate: (lambda: LambdaClient, functionName: string) => Promise<void>;
  now: () => number;
}

export interface Settings {
  tableName: string;
  bucketName: string;
  registry: Map<string, Registration>;
  cooldownMs: number;
  stableAfterMs: number;
  liveErrorsLookbackMs: number;
}

/** SNS alarm messages use name/value; DescribeAlarms uses Name/Value. */
type Dimension = { name?: string; Name?: string; value?: string; Value?: string };

export interface AlarmTrigger {
  Dimensions?: Dimension[];
  Metrics?: Array<{ MetricStat?: { Metric?: { Dimensions?: Dimension[] } } }>;
}

/** A CloudWatch alarm notification, or a registered alarm re-checked by the scheduled check. */
export interface AlarmMessage {
  AlarmName: string;
  NewStateValue: string;
  Trigger?: AlarmTrigger;
}

export type RollbackEvent =
  | { type: 'scheduled-check' }
  | { type: 'sync'; functionName?: string }
  | { Records: Array<{ Sns: { Message: string } }> };

/**
 * Single-metric alarms carry Trigger.Dimensions; metric-math alarms carry one
 * Trigger.Metrics[].MetricStat.Metric.Dimensions per input metric.
 */
export function functionFromAlarm(alarm: AlarmMessage): string | undefined {
  const trigger = alarm.Trigger ?? {};
  const dimensionSets = [trigger.Dimensions, ...(trigger.Metrics ?? []).map((m) => m.MetricStat?.Metric?.Dimensions)]
    .filter((dims): dims is NonNullable<typeof dims> => Boolean(dims));
  return dimensionSets
    .flatMap((dims) => dims.filter((d) => (d.name ?? d.Name) === 'FunctionName'))
    .map((d) => d.value ?? d.Value)[0];
}

/**
 * The guards an automatic alias rollback must pass, in order: deployment window, cooldown (after a
 * rollback or a $LATEST-only revert), consecutive-rollback limit. Returns the reason to skip, or
 * undefined to go ahead.
 */
export function rollbackGuard(
  state: CurrentState | undefined,
  registration: Registration,
  label: string,
  now: number,
  cooldownMs: number,
): string | undefined {
  // Only roll back a recent change. CURRENT.updatedAt is when the last deploy (recorded by sync
  // right after promotion, or within one scheduled check) or rollback happened.
  const changedAt = state?.updatedAt ? new Date(state.updatedAt).getTime() : NaN;
  const sinceChangeMs = now - changedAt;
  if (!(sinceChangeMs <= registration.deploymentWindowMinutes * 60_000)) {
    const since = Number.isNaN(changedAt)
      ? 'no deploy or rollback recorded'
      : `last ${state?.updatedBy ?? 'change'} ${Math.round(sinceChangeMs / 60_000)} min ago`;
    return `${label}: no deploy or rollback in the last ${registration.deploymentWindowMinutes} min (${since}), not rolling back`;
  }
  // A recent $LATEST-only revert also counts: the alarm may still be in ALARM from $LATEST's errors
  // while the healthy live version is being re-evaluated.
  for (const [at, what] of [[state?.lastRollbackAt, 'rolled back'], [state?.lastLatestRevertAt, 'had $LATEST reverted']] as const) {
    if (!at) continue;
    const sinceMs = now - new Date(at).getTime();
    if (sinceMs < cooldownMs) {
      return `${label} ${what} ${Math.round(sinceMs / 1000)}s ago, giving the alarm time to evaluate version ${state?.version}`;
    }
  }
  const count = state?.rollbackCount ?? 0;
  if (count >= registration.maxConsecutiveRollbacks) {
    return `${label} already rolled back ${count} times in a row (max ${registration.maxConsecutiveRollbacks}), manual action needed`;
  }
  return undefined;
}

/** How long a version had been stable when it is rolled back from (from its stableAt to `now`). */
export function stableFor(item: { stable?: boolean; stableAt?: string } | undefined, nowIso: string) {
  const stableForSeconds = item?.stable === true && item.stableAt
    ? Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(item.stableAt)) / 1000))
    : 0;
  return {
    stableForSeconds,
    stableFor: stableForSeconds > 0 ? formatDuration(stableForSeconds) : 'not marked stable while live',
  };
}

export function createRollbackSystem(deps: Deps, settings: Settings) {
  const { tableName: TABLE, bucketName: BUCKET, registry } = settings;
  const nowIso = () => new Date(deps.now()).toISOString();

  // -------------------------------------------------------------------------------------------
  // Sync: archive new versions to S3 + DynamoDB, and record alias moves made outside the system.
  // -------------------------------------------------------------------------------------------

  async function syncAll(onlyFunction?: string) {
    const names = [...registry.keys()].filter((name) => !onlyFunction || name === onlyFunction);
    if (onlyFunction && names.length === 0) {
      return [skip(`${onlyFunction} is not registered for rollback (see rollback-config.json)`)];
    }
    const results = [];
    for (const functionName of names) {
      try {
        const clients = await deps.scopedClients(functionName);
        results.push(await syncFunction(clients, functionName));
      } catch (err) {
        const { name, message } = err as Error;
        console.error(`Sync of ${functionName} failed: ${name}: ${message}`);
        results.push({ functionName, synced: false, error: message });
      }
    }
    return results;
  }

  async function syncFunction(clients: ScopedClients, functionName: string) {
    const known = new Set((await queryVersions(clients.ddb, TABLE, functionName)).map((item) => Number(item.version.N)));

    const archived: number[] = [];
    let Marker: string | undefined;
    do {
      const page = await clients.lambda.send(new ListVersionsByFunctionCommand({ FunctionName: functionName, Marker }));
      for (const { Version } of page.Versions ?? []) {
        if (!Version || Version === '$LATEST' || known.has(Number(Version))) continue;
        await archiveVersion(clients, functionName, Number(Version));
        archived.push(Number(Version));
      }
      Marker = page.NextMarker;
    } while (Marker);

    const currentVersion = await syncCurrent(clients, functionName);
    return { functionName, synced: true, archived, currentVersion };
  }

  // Copies a published version's package to S3 and records its metadata.
  async function archiveVersion({ lambda, s3, ddb }: ScopedClients, functionName: string, version: number) {
    const { Code, Configuration } = await lambda.send(new GetFunctionCommand({
      FunctionName: functionName,
      Qualifier: String(version),
    }));
    if (!Configuration || !Code?.Location) throw new Error(`${functionName} v${version} has no code location`);
    if (Configuration.PackageType === 'Image') {
      throw new Error(`${functionName} v${version} is a container image; only zip packages can be archived`);
    }
    const response = await deps.fetch(Code.Location);
    if (!response.ok) throw new Error(`Downloading ${functionName} v${version} failed: HTTP ${response.status}`);
    const zip = new Uint8Array(await response.arrayBuffer());

    const key = s3Key(functionName, version);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: zip,
      ContentType: 'application/zip',
      Metadata: { 'code-sha256': Configuration.CodeSha256 ?? '', 'function-version': String(version) },
    }));

    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        functionName: S(functionName),
        sk: S(versionSk(version)),
        version: N(version),
        codeSha256: S(Configuration.CodeSha256),
        description: S(Configuration.Description ?? ''),
        lastModified: S(Configuration.LastModified),
        runtime: S(Configuration.Runtime ?? ''),
        handler: S(Configuration.Handler ?? ''),
        memorySize: N(Configuration.MemorySize ?? 0),
        timeout: N(Configuration.Timeout ?? 0),
        codeSize: N(Configuration.CodeSize ?? 0),
        s3Bucket: S(BUCKET),
        s3Key: S(key),
        archivedAt: S(nowIso()),
      },
    }));
    console.log(`Archived ${functionName} v${version} (${Configuration.CodeSha256}) to s3://${BUCKET}/${key}`);
  }

  // If the alias points somewhere the table doesn't know about, it was moved outside the rollback
  // system (a deploy promoted a version, or someone moved it by hand): record it as the current
  // version, mark that version as having been live, and reset the rollback count.
  async function syncCurrent({ lambda, ddb }: ScopedClients, functionName: string) {
    const { alias } = registry.get(functionName)!;
    const aliasVersion = Number((await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: alias }))).FunctionVersion);

    const current = await getCurrent(ddb, TABLE, functionName);
    if (current?.version === aliasVersion) return aliasVersion;

    const now = nowIso();
    try {
      await ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: {
          functionName: S(functionName),
          sk: S(CURRENT_SK),
          version: N(aliasVersion),
          ...(current ? { previousVersion: N(current.version) } : {}),
          updatedBy: S('deploy'),
          updatedAt: S(now),
          rollbackCount: N(0),
        },
        // Don't overwrite a concurrent rollback's record.
        ConditionExpression: current ? 'version = :seen' : 'attribute_not_exists(sk)',
        ExpressionAttributeValues: current ? { ':seen': N(current.version) } : undefined,
      }));
      await markLive(ddb, TABLE, functionName, aliasVersion, now);
      console.log(`${functionName}:${alias} moved to v${aliasVersion} outside the rollback system; recorded as deploy`);
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
    return aliasVersion;
  }

  // -------------------------------------------------------------------------------------------
  // Alarms
  // -------------------------------------------------------------------------------------------

  async function describeRegisteredAlarms(): Promise<MetricAlarm[]> {
    const alarmNames = [...registry.values()].flatMap(({ alarms }) => [...alarms]);
    if (alarmNames.length === 0) return [];
    const { MetricAlarms = [] } = await deps.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: alarmNames }));
    return MetricAlarms;
  }

  // Scheduled check: a function whose registered alarms are all OK, and whose live version has been
  // live for at least STABLE_AFTER_MINUTES, gets that version marked stable, both on CURRENT and on
  // the version's own item. Done once per version (until it is rolled back from).
  async function markStable(alarms: MetricAlarm[]) {
    const states = new Map(alarms.map((alarm) => [alarm.AlarmName, alarm.StateValue]));
    const results = [];
    for (const [functionName, { alarms: registered }] of registry) {
      if (registered.size === 0) continue;
      const notOk = [...registered].filter((name) => states.get(name) !== 'OK');
      if (notOk.length > 0) {
        console.log(`${functionName}: not stable, alarms not OK: ${notOk.map((name) => `${name}=${states.get(name) ?? 'missing'}`).join(', ')}`);
        continue;
      }
      try {
        const { ddb } = await deps.scopedClients(functionName);
        const current = await getCurrent(ddb, TABLE, functionName);
        if (!current || current.stable) continue;
        const liveForMs = deps.now() - new Date(current.updatedAt ?? NaN).getTime();
        if (!(liveForMs >= settings.stableAfterMs)) {
          console.log(`${functionName}: v${current.version} live for ${Math.round(liveForMs / 1000)}s, not marked stable yet`);
          continue;
        }
        results.push(await recordStable(ddb, functionName, current.version));
      } catch (err) {
        const { name, message } = err as Error;
        console.error(`Marking ${functionName} stable failed: ${name}: ${message}`);
        results.push({ functionName, stable: false, error: message });
      }
    }
    return results;
  }

  async function recordStable(ddb: DynamoDBClient, functionName: string, version: number) {
    const now = nowIso();
    try {
      // Only if CURRENT still points at this version (a rollback may have just moved it).
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: { functionName: S(functionName), sk: S(CURRENT_SK) },
        UpdateExpression: 'SET stable = :true, stableAt = :now',
        ConditionExpression: 'version = :version',
        ExpressionAttributeValues: { ':true': BOOL(true), ':now': S(now), ':version': N(version) },
      }));
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
      return { functionName, version, stable: false, reason: 'live version changed' };
    }
    try {
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: { functionName: S(functionName), sk: S(versionSk(version)) },
        UpdateExpression: 'SET stable = :true, stableAt = :now',
        ConditionExpression: 'attribute_exists(sk)',
        ExpressionAttributeValues: { ':true': BOOL(true), ':now': S(now) },
      }));
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
    console.log(`${functionName}: all alarms OK, v${version} marked stable`);
    return { functionName, version, stable: true };
  }

  // Scheduled re-check: treat every registered alarm still in ALARM as if it had just fired.
  async function checkAlarms(alarms: MetricAlarm[]) {
    const results = [];
    for (const alarm of alarms) {
      console.log(`Scheduled check: alarm '${alarm.AlarmName}' is ${alarm.StateValue}`);
      if (alarm.StateValue !== 'ALARM') {
        results.push(skip(`alarm '${alarm.AlarmName}' is ${alarm.StateValue}`));
        continue;
      }
      results.push(await handleAlarm({
        AlarmName: alarm.AlarmName!,
        NewStateValue: alarm.StateValue,
        Trigger: { Dimensions: alarm.Dimensions, Metrics: alarm.Metrics as AlarmTrigger['Metrics'] },
      }));
    }
    return results;
  }

  async function handleAlarm(alarm: AlarmMessage) {
    console.log(`Alarm '${alarm.AlarmName}' state: ${alarm.NewStateValue}`);
    if (alarm.NewStateValue !== 'ALARM') return skip(`state is ${alarm.NewStateValue}, not ALARM`);

    const functionName = functionFromAlarm(alarm);
    if (!functionName) return skip('alarm has no FunctionName dimension');

    const { clients, reason } = await preHook(functionName, alarm.AlarmName);
    if (!clients) return skip(reason!);
    const { lambda, ddb } = clients;
    const registration = registry.get(functionName)!;
    const aliasName = registration.alias;

    // Make sure the newest version is archived and any deploy since the last run is recorded.
    await syncFunction(clients, functionName);

    const alias = await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: aliasName }));
    const currentVersion = Number(alias.FunctionVersion);
    const state = await getCurrent(ddb, TABLE, functionName);

    // $LATEST-only failure: new code reached $LATEST without the alias moving, and the alias itself
    // is healthy. Revert only $LATEST to the live version's code.
    const latestOnly = await handleLatestOnly(clients, functionName, aliasName, currentVersion, state, alarm);
    if (latestOnly) return latestOnly;

    const label = `${functionName}:${aliasName} v${currentVersion}`;
    const blocked = rollbackGuard(state, registration, label, deps.now(), settings.cooldownMs);
    if (blocked) return skip(blocked);
    const rollbackNumber = (state?.rollbackCount ?? 0) + 1;

    const target = await findRollbackTarget(ddb, TABLE, functionName, currentVersion);
    if (!target) {
      return skip(`${functionName}:${aliasName} is on version ${currentVersion}, no older version that was live to roll back to`);
    }

    console.log(`Rolling back ${functionName}:${aliasName}: ${currentVersion} -> ${target.version} (automatic rollback #${rollbackNumber})`);
    // RevisionId makes the update fail if someone else moved the alias since we read it.
    await lambda.send(new UpdateAliasCommand({
      FunctionName: functionName,
      Name: aliasName,
      FunctionVersion: String(target.version),
      RevisionId: alias.RevisionId,
    }));

    await restoreLatest(clients, functionName, target);
    await recordRollback(ddb, functionName, {
      from: currentVersion,
      to: target.version,
      by: 'auto-rollback',
      rollbackCount: rollbackNumber,
      reason: `alarm ${alarm.AlarmName}`,
    });

    return {
      rolledBack: true,
      functionName,
      aliasName,
      from: currentVersion,
      to: target.version,
      rollbackNumber,
      restoredFrom: `s3://${target.s3Bucket}/${target.s3Key}`,
    };
  }

  // Returns a result when this alarm is a $LATEST-only failure (handled or skipped here), or undefined
  // to continue with a normal alias rollback. It is $LATEST-only when $LATEST runs different code
  // from the live version and the alias had no errors in the last LIVE_ERRORS_LOOKBACK_MINUTES.
  async function handleLatestOnly(
    clients: ScopedClients,
    functionName: string,
    aliasName: string,
    liveVersion: number,
    state: CurrentState | undefined,
    alarm: AlarmMessage,
  ) {
    const { lambda, ddb } = clients;
    const { deploymentWindowMinutes } = registry.get(functionName)!;

    const { Configuration: latest } = await lambda.send(new GetFunctionCommand({ FunctionName: functionName }));
    const live = await getVersionItem(ddb, TABLE, functionName, liveVersion);
    if (!live) {
      console.log(`${functionName} v${liveVersion} is not archived; can't compare it with $LATEST`);
      return undefined;
    }
    if (!latest || latest.CodeSha256 === live.codeSha256) return undefined;

    const liveErrors = await countAliasErrors(functionName, aliasName);
    if (liveErrors > 0) {
      console.log(`${functionName}: $LATEST differs from v${liveVersion}, but ${functionName}:${aliasName} also had ${liveErrors} errors; rolling back the alias`);
      return undefined;
    }
    console.log(`${functionName}: $LATEST (${latest.CodeSha256}) differs from live v${liveVersion} (${live.codeSha256}) and ${aliasName} has no errors: $LATEST-only failure`);

    // Same guards as an alias rollback, measured from when $LATEST's code was changed.
    const changedAt = Date.parse(String(latest.LastModified).replace(/\+0000$/, 'Z'));
    const sinceChangeMs = deps.now() - changedAt;
    if (!(sinceChangeMs <= deploymentWindowMinutes * 60_000)) {
      return skip(`${functionName} $LATEST: last changed ${Math.round(sinceChangeMs / 60_000)} min ago, outside the ${deploymentWindowMinutes} min deployment window, not reverting`);
    }
    if (state?.lastLatestRevertAt && deps.now() - new Date(state.lastLatestRevertAt).getTime() < settings.cooldownMs) {
      return skip(`${functionName} $LATEST was reverted less than ${settings.cooldownMs / 60_000} min ago`);
    }

    await restoreLatest(clients, functionName, live);
    await recordLatestRevert(ddb, functionName, {
      fromSha: latest.CodeSha256 ?? '',
      toVersion: liveVersion,
      reason: `alarm ${alarm.AlarmName}`,
    });

    return {
      rolledBack: true,
      latestOnly: true,
      functionName,
      aliasName,
      from: '$LATEST',
      to: liveVersion,
      restoredFrom: `s3://${live.s3Bucket}/${live.s3Key}`,
    };
  }

  // Sum of Errors on <fn>:<alias> over the lookback window.
  async function countAliasErrors(functionName: string, aliasName: string) {
    const end = new Date(deps.now());
    const start = new Date(end.getTime() - settings.liveErrorsLookbackMs);
    const { MetricDataResults = [] } = await deps.cloudwatch.send(new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [{
        Id: 'aliasErrors',
        MetricStat: {
          Metric: {
            Namespace: 'AWS/Lambda',
            MetricName: 'Errors',
            Dimensions: [
              { Name: 'FunctionName', Value: functionName },
              { Name: 'Resource', Value: `${functionName}:${aliasName}` },
            ],
          },
          Period: 60,
          Stat: 'Sum',
        },
      }],
    }));
    return (MetricDataResults[0]?.Values ?? []).reduce((sum, value) => sum + value, 0);
  }

  // -------------------------------------------------------------------------------------------
  // Rollback steps
  // -------------------------------------------------------------------------------------------

  // Lambda pulls the archived zip from S3 itself; it becomes $LATEST's code, no version is published.
  // Only code is restored; $LATEST keeps its current configuration.
  async function restoreLatest({ lambda }: ScopedClients, functionName: string, target: ArchivedVersion) {
    console.log(`Restoring $LATEST of ${functionName} from s3://${target.s3Bucket}/${target.s3Key}`);
    const updated = await lambda.send(new UpdateFunctionCodeCommand({
      FunctionName: functionName,
      S3Bucket: target.s3Bucket,
      S3Key: target.s3Key,
      Publish: false,
    }));
    await deps.waitForUpdate(lambda, functionName);
    if (updated.CodeSha256 !== target.codeSha256) {
      throw new Error(`$LATEST code hash ${updated.CodeSha256} does not match version ${target.version} (${target.codeSha256})`);
    }
    console.log(`$LATEST of ${functionName} now runs the code of version ${target.version}`);
  }

  // A $LATEST-only revert doesn't move the alias, so it doesn't count towards the consecutive-rollback
  // limit; it only starts the cooldown and is recorded on CURRENT.
  async function recordLatestRevert(ddb: DynamoDBClient, functionName: string, { fromSha, toVersion, reason }: {
    fromSha: string; toVersion: number; reason: string;
  }) {
    try {
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: { functionName: S(functionName), sk: S(CURRENT_SK) },
        UpdateExpression: 'SET lastLatestRevertAt = :at, latestRevertedFromSha = :sha, latestRevertedToVersion = :version, latestRevertReason = :reason',
        ConditionExpression: 'attribute_exists(sk)',
        ExpressionAttributeValues: { ':at': S(nowIso()), ':sha': S(fromSha), ':version': N(toVersion), ':reason': S(reason) },
      }));
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
    console.log(`${functionName}: $LATEST reverted to the code of v${toVersion}`);
  }

  async function recordRollback(ddb: DynamoDBClient, functionName: string, { from, to, by, rollbackCount, reason }: {
    from: number; to: number; by: string; rollbackCount: number; reason: string;
  }) {
    const now = nowIso();
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        functionName: S(functionName),
        sk: S(CURRENT_SK),
        version: N(to),
        previousVersion: N(from),
        updatedBy: S(by),
        updatedAt: S(now),
        lastRollbackAt: S(now),
        rollbackCount: N(rollbackCount),
      },
    }));

    // How long the version rolled back from had been stable: from its stableAt until now. Only counts
    // if it is still marked stable, i.e. it was marked stable during this time live.
    const { Item: fromItem } = await ddb.send(new GetItemCommand({
      TableName: TABLE,
      Key: { functionName: S(functionName), sk: S(versionSk(from)) },
      ProjectionExpression: 'stable, stableAt',
      ConsistentRead: true,
    }));
    const duration = stableFor({ stable: fromItem?.stable?.BOOL, stableAt: fromItem?.stableAt?.S }, now);

    try {
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: { functionName: S(functionName), sk: S(versionSk(from)) },
        UpdateExpression: 'SET rolledBackAt = :at, rolledBackBy = :by, rollbackReason = :reason, stable = :false, '
          + 'stableForSeconds = :stableForSeconds, stableFor = :stableFor',
        ConditionExpression: 'attribute_exists(sk)',
        ExpressionAttributeValues: {
          ':at': S(now),
          ':by': S(by),
          ':reason': S(reason),
          ':false': BOOL(false),
          ':stableForSeconds': N(duration.stableForSeconds),
          ':stableFor': S(duration.stableFor),
        },
      }));
      console.log(`${functionName} v${from} was stable for: ${duration.stableFor}`);
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Pre-hook
  // -------------------------------------------------------------------------------------------

  // Runs before any rollback: checks the function is registered and the alarm is one of its
  // registered alarms. If so, returns clients scoped to that one function.
  async function preHook(functionName: string, alarmName: string): Promise<{ clients?: ScopedClients; reason?: string }> {
    const registration = registry.get(functionName);
    if (!registration) return { reason: `${functionName} is not registered for rollback (see rollback-config.json)` };
    if (!registration.alarms.has(alarmName)) {
      return { reason: `alarm '${alarmName}' is not registered for ${functionName} (see rollback-config.json)` };
    }
    console.log(`Pre-hook: ${functionName} registered with alarm '${alarmName}', rollback enabled`);
    return { clients: await deps.scopedClients(functionName) };
  }

  // -------------------------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------------------------

  return async function handle(event: RollbackEvent) {
    console.log('Event:', JSON.stringify(event));
    if ('type' in event && event.type === 'scheduled-check') {
      await syncAll();
      const alarms = await describeRegisteredAlarms();
      const stable = await markStable(alarms);
      const rollbacks = await checkAlarms(alarms);
      return [...stable, ...rollbacks];
    }
    if ('type' in event && event.type === 'sync') return syncAll(event.functionName);

    const results = [];
    for (const record of ('Records' in event ? event.Records : []) ?? []) {
      results.push(await handleAlarm(JSON.parse(record.Sns.Message)));
    }
    return results;
  };
}
