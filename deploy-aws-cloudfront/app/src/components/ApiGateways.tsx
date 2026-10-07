// API Gateways: the region's APIs from the dashboard API, with search and refresh, and the
// selected API's deployments (restorable for the APIs this project deploys), stages and
// configuration next to them.
import { useEffect, useMemo, useState } from 'react';
import {
  fetchApiGatewayDetails, fetchApiGateways, fetchApiSpec, restoreApiDeployment,
  type ApiGateway, type ApiGatewayDetails, type ApiGatewayList, type RecordedApiDeployment,
} from '../api.js';
import { DateCell, loadState, useLoad } from './loading.js';
import { MenuButton, type MenuItem } from './Menu.js';
import { ConfirmFacts, ConfirmNote, outcomeMessage, useOperationDialog } from './Operation.js';
import { DetailPanel, ListPanel } from './Panels.js';
import { DataTable, RollbackButton, StageTags, Tag, type TableMessage } from './ui.js';

const matches = (api: ApiGateway, query: string) =>
  [api.name, api.id, api.type, ...api.stages].some((value) => value.toLowerCase().includes(query));

const typeLabel = { REST: 'REST API', HTTP: 'HTTP API', WEBSOCKET: 'WebSocket API' };

const formatAt = (iso: string) => new Date(iso).toLocaleString();

/**
 * What restoring `target` changes in the routes the stage serves now (`live`), from both
 * deployments' OpenAPI exports in S3: shown in the confirmation while it loads.
 */
function RouteChanges({ apiId, target, live }: { apiId: string; target: RecordedApiDeployment; live?: RecordedApiDeployment }) {
  const [changes, setChanges] = useState<{ removed: string[]; added: string[]; total: number } | { error: string }>();
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    Promise.all([fetchApiSpec(apiId, target.deployedAt, controller.signal), fetchApiSpec(apiId, live.deployedAt, controller.signal)]).then(
      ([to, from]) => setChanges({
        removed: from.routes.filter((r) => !to.routes.includes(r)),
        added: to.routes.filter((r) => !from.routes.includes(r)),
        total: to.routes.length,
      }),
      (err) => { if (!controller.signal.aborted) setChanges({ error: (err as Error).message }); },
    );
    return () => controller.abort();
  }, [apiId, target.deployedAt, live?.deployedAt]);

  if (!live) return <p className="muted-text">Routes: no live deployment recorded to compare with.</p>;
  if (!changes) return <p className="muted-text">Comparing its routes with the live deployment's…</p>;
  if ('error' in changes) return <p className="muted-text">Routes: could not compare ({changes.error}).</p>;
  if (!changes.removed.length && !changes.added.length) return <p className="muted-text">Routes: the same {changes.total} as live.</p>;
  return (
    <div className="route-changes">
      {changes.removed.length > 0 && (
        <div><span className="route-changes-label">Routes it removes</span>
          <ul>{changes.removed.map((r) => <li key={r} className="removed">{r}</li>)}</ul></div>
      )}
      {changes.added.length > 0 && (
        <div><span className="route-changes-label">Routes it brings back</span>
          <ul>{changes.added.map((r) => <li key={r} className="added">{r}</li>)}</ul></div>
      )}
    </div>
  );
}

/** "users v3 · messages v5" (rollback-factory-demo-api-<resource>-<env>), or "Lambda v5" for older records. */
function lambdaVersionsHint(d: RecordedApiDeployment) {
  if (d.lambdaVersions) {
    return Object.entries(d.lambdaVersions)
      .map(([fn, version]) => `${/-api-(.+)-[a-z0-9]+$/.exec(fn)?.[1] ?? fn} v${version}`)
      .join(' · ');
  }
  return d.lambdaVersion && `Lambda v${d.lambdaVersion}`;
}

/** s3://<bucket>/api-user-dev/20261007T120000Z/openapi.json -> 20261007T120000Z (the export's folder) */
const specFolder = (spec: string) => spec.split('/').slice(-2, -1)[0];

/** One recorded deployment as a menu hint: where it came from and what happened to it. */
const recordHint = (d: RecordedApiDeployment) => [
  d.source,
  d.commit?.slice(0, 7),
  lambdaVersionsHint(d),
  d.verified && 'verified',
  d.rolledBack && 'rolled back',
].filter(Boolean).join(' · ');

export function ApiGatewaySection() {
  const [reloads, setReloads] = useState(0);
  const list = useLoad<ApiGatewayList>(`list#${reloads}`, (signal) => fetchApiGateways(signal));
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();

  const apis = list.data?.apis ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? apis.filter((api) => matches(api, q)) : apis;
  }, [apis, query]);
  // the clicked API while it is listed, else the first one shown
  const selected = shown.find((api) => api.id === selectedId) ?? shown[0];

  let message: TableMessage | undefined;
  if (list.failed && !list.data) message = { text: 'Could not load the API Gateways. Try refreshing.', error: true };
  else if (!list.data) message = { text: 'Loading API Gateways…' };
  else if (!apis.length) message = { text: `No API Gateways in ${list.data.region}.` };
  else if (!shown.length) message = { text: `No API Gateways match “${query.trim()}”.` };

  return (
    <div className="panel-row">
      <ListPanel
        id="api-gateways" icon="apiGateway" tint="tint-api" title="API Gateways"
        state={loadState(list)}
        count={list.data && (shown.length === apis.length ? `${apis.length}` : `${shown.length} of ${apis.length}`)}
        description={`The REST, HTTP and WebSocket APIs${list.data ? ` in ${list.data.region}` : ''}, with their stages and latest deployment.`}
        searchPlaceholder="Search APIs..." search={{ value: query, onChange: setQuery }}
        onRefresh={() => setReloads((n) => n + 1)} refreshing={list.loading}
      >
        {/* the list stays while a refresh fails: say so above it */}
        {list.failed && list.data && <p className="refresh-error" role="alert">Refresh failed, showing the last list loaded.</p>}
        <DataTable rows={shown} rowKey={(api) => api.id} message={message}
          selectedKey={selected?.id} onSelect={(api) => setSelectedId(api.id)} columns={[
            {
              header: 'Name',
              cell: (api) => (
                <>
                  <span className={`dot ${api.stages.length ? 'ok' : 'muted'}`} />
                  <button type="button" className="link-button" aria-pressed={api.id === selected?.id}
                    onClick={(e) => { e.stopPropagation(); setSelectedId(api.id); }}>
                    {api.name}
                  </button>
                </>
              ),
            },
            { header: 'API ID', cell: (api) => api.id },
            { header: 'Type', cell: (api) => api.type },
            { header: 'Stages', cell: (api) => (api.stages.length ? <StageTags stages={api.stages} /> : '—') },
            { header: 'Last Deployed', cell: (api) => <DateCell iso={api.lastDeployed} /> },
          ]} />
      </ListPanel>
      {selected
        ? <ApiGatewayDetailPanel api={selected} reloads={reloads} />
        : <section className="panel detail placeholder" aria-label="API details"><p>{apis.length ? 'No API selected.' : 'No API to show.'}</p></section>}
    </div>
  );
}

function ApiGatewayDetailPanel({ api, reloads }: { api: ApiGateway; reloads: number }) {
  // refreshing the list reloads the selected API too, and so does a restore
  const [restores, setRestores] = useState(0);
  const details = useLoad<ApiGatewayDetails>(`${api.type}:${api.id}#${reloads}.${restores}`, (signal) => fetchApiGatewayDetails(api, signal));
  const data = details.data;
  // the deployedAt being restored, and the last restore's outcome, for the API they belong to
  const [restoring, setRestoring] = useState<{ apiId: string; deployedAt: string }>();
  const [outcome, setOutcome] = useState<{ apiId: string; text: string; error?: boolean }>();
  // the popup that follows a restore while the rollback service runs it
  const operation = useOperationDialog();

  async function restore(d: RecordedApiDeployment, verb = 'Restore') {
    const what = `${api.name} stage ${d.stageName} to deployment ${d.deploymentId}, recorded ${formatAt(d.deployedAt)}`;
    setRestoring({ apiId: api.id, deployedAt: d.deployedAt });
    setOutcome(undefined);
    const live = data?.recorded?.find((r) => r.current && r.stageName === d.stageName);
    const ended = await operation.start(`${verb} ${what}`, () => restoreApiDeployment(api.id, d.deployedAt), {
      confirmLabel: verb,
      danger: true,
      body: (
        <>
          <ConfirmFacts rows={[
            ['API', <>{api.name} <span className="muted-text">· stage {d.stageName}</span></>],
            ['Live now', live ? <>{live.deploymentId} <span className="muted-text">· {formatAt(live.deployedAt)}</span></> : '—'],
            [verb === 'Restore' ? 'Restores' : 'Rolls back to', <>{d.deploymentId} <span className="muted-text">· {formatAt(d.deployedAt)} · {recordHint(d)}</span></>],
          ]} />
          <RouteChanges apiId={api.id} target={d} live={live} />
          <ConfirmNote>
            The rollback service re-imports that deployment's OpenAPI export and redeploys stage {d.stageName}.
            The Lambda aliases stay on live: the code isn't rolled back.
          </ConfirmNote>
        </>
      ),
    });
    if (ended.status === 'cancelled') {
      setRestoring(undefined);
      return;
    }
    setOutcome({
      apiId: api.id,
      ...outcomeMessage(ended, `Restored ${what}. It counts as verified once the integration tests pass again.`, `${verb} failed`),
    });
    setRestoring(undefined);
    setRestores((n) => n + 1);
  }
  // only once confirmed: the buttons stay as they are while the confirmation is open
  const busy = restoring?.apiId === api.id && operation.busy;

  const outcomeLine = outcome?.apiId === api.id && (
    <p className={outcome.error ? 'refresh-error' : 'restore-done'} role={outcome.error ? 'alert' : 'status'}>{outcome.text}</p>
  );

  /** Why a stage can't be rolled back from here, if it can't. */
  function stageRollbackDisabled(stage: string) {
    if (!data?.recorded) return 'Only api-user-<env> keeps a deployment history (DynamoDB + S3) to roll back to.';
    if (!data.recorded.some((r) => r.stageName === stage)) return `${stage} has no recorded deployments: CI redeploys it on every deploy.`;
    return undefined;
  }

  /** The stage's recorded deployments, newest first; the previous verified one is the usual rollback. */
  function stageItems(stage: string): MenuItem[] {
    const records = (data?.recorded ?? []).filter((r) => r.stageName === stage);
    const liveAt = records.find((r) => r.current)?.deployedAt ?? '';
    const previous = records.find((r) => !r.current && r.verified && !r.rolledBack && r.deployedAt < liveAt);
    return records.map((d) => ({
      key: d.deployedAt,
      label: `${d.deploymentId} · ${formatAt(d.deployedAt)}${d === previous ? ' (previous verified)' : ''}`,
      hint: recordHint(d),
      disabledReason: d.current ? 'live now' : undefined,
      onSelect: () => restore(d, 'Roll back'),
    }));
  }

  const message: TableMessage | undefined = details.failed && !data
    ? { text: `Could not load ${api.name}. Try refreshing.`, error: true }
    : !data ? { text: 'Loading…' } : undefined;

  return (
    <>
    {operation.dialog}
    <DetailPanel
      id="api-gateway-details" icon="apiGateway" tint="tint-api" name={api.name}
      badge={api.stages.length ? 'Deployed' : undefined}
      subtitle={<>{api.id} &nbsp; {typeLabel[api.type]}</>}
      tabs={['Deployments', 'Stages', 'Configuration']}
      state={loadState(details)}
    >
      {(tab) => {
        if (tab === 'Stages') {
          return (
            <>
            {outcomeLine}
            <DataTable rows={data?.stages ?? []} rowKey={(s) => s.name}
              message={message ?? (data!.stages.length ? undefined : { text: 'No stages: this API was never deployed.' })}
              columns={[
                { header: 'Stage Name', cell: (s) => <><span className={`dot ${s.deploymentId ? 'ok' : 'muted'}`} />{s.name}</> },
                { header: 'Deployment ID', cell: (s) => s.deploymentId ?? '—' },
                { header: 'Deployed At', cell: (s) => <DateCell iso={s.deployedAt} /> },
                {
                  header: 'Actions',
                  cell: (s) => (
                    <MenuButton label="Rollback" heading={`Roll ${s.name} back to…`} items={stageItems(s.name)}
                      disabledReason={stageRollbackDisabled(s.name)} busy={busy} />
                  ),
                },
              ]} />
            </>
          );
        }
        if (tab === 'Deployments' && data?.recorded) {
          return (
            <>
              {outcomeLine}
              <DataTable rows={data.recorded} rowKey={(d) => d.deployedAt}
                message={message ?? (data.recorded.length ? undefined : { text: 'No deployment recorded yet.' })}
                columns={[
                  {
                    header: 'Deployment',
                    cell: (d) => (
                      <div className="stacked" title={[d.description, d.spec].filter(Boolean).join('\n')}>
                        <span>{d.deploymentId} <span className="small muted-text">{d.stageName}</span></span>
                        {/* where it came from: the Source column, folded in to make room for the OpenAPI export */}
                        <span className="small muted-text">{d.source}{d.commit && ` · ${d.commit.slice(0, 7)}`}</span>
                        {(d.current || d.verified || d.rolledBack) && (
                          <span className="tags">
                            {d.current && <Tag kind="prod">live</Tag>}
                            {d.verified && <Tag kind="staging">verified</Tag>}
                            {d.rolledBack && <Tag kind="bad">rolled back</Tag>}
                          </span>
                        )}
                      </div>
                    ),
                  },
                  { header: 'Deployed At', cell: (d) => <DateCell iso={d.deployedAt} />, className: 'date-wrap' },
                  // the OpenAPI JSON of each deployment in S3; the one the stage serves now is marked
                  {
                    header: 'OpenAPI export',
                    cell: (d) => (
                      <div className="stacked" title={d.spec}>
                        <span className="spec-file">{specFolder(d.spec)}/<br />openapi.json</span>
                        {d.current && <Tag kind="prod">deployed</Tag>}
                      </div>
                    ),
                  },
                  {
                    header: 'Actions',
                    cell: (d) => (
                      <RollbackButton
                        label={busy && restoring!.deployedAt === d.deployedAt ? 'Restoring…' : 'Restore'}
                        disabledReason={d.current ? `${d.stageName} serves this deployment.` : busy ? 'A restore is running.' : undefined}
                        onClick={() => restore(d)} />
                    ),
                  },
                ]} />
            </>
          );
        }
        if (tab === 'Deployments') {
          // an API this project doesn't deploy: API Gateway's own deployments, nothing to restore from
          return (
            <DataTable rows={data?.deployments ?? []} rowKey={(d) => d.id}
              message={message ?? (data!.deployments.length ? undefined : { text: 'No deployments.' })}
              columns={[
                // the stages serving a deployment go under its id, to keep the table narrow
                { header: 'Deployment', cell: (d) => <div className="stacked">{d.id}{d.stages.length > 0 && <StageTags stages={d.stages} />}</div> },
                { header: 'Description', cell: (d) => d.description || '—', className: 'wrap' },
                { header: 'Created', cell: (d) => <DateCell iso={d.createdAt} /> },
              ]} />
          );
        }
        if (message) return <DataTable rows={[]} rowKey={() => ''} message={message} columns={[{ header: 'Setting', cell: () => null }]} />;
        return (
          <dl className="config-list">
            {data!.configuration.map(({ label, value }) => (
              <div key={label}><dt>{label}</dt><dd>{label === 'Created' ? <DateCell iso={value} /> : value}</dd></div>
            ))}
          </dl>
        );
      }}
    </DetailPanel>
    </>
  );
}
