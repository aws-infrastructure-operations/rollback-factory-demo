// API Gateways: the region's APIs from the dashboard API, with search and refresh, and the
// selected API's stages, deployments and configuration next to them.
import { useEffect, useMemo, useState } from 'react';
import {
  fetchApiGatewayDetails, fetchApiGateways, type ApiGateway, type ApiGatewayDetails, type ApiGatewayList,
} from '../api.js';
import { DetailPanel, ListPanel } from './Panels.js';
import { DataTable, RollbackButton, StageTags, type TableMessage } from './ui.js';

interface Loaded<T> {
  /** the last data that loaded; kept on screen while refreshing */
  data?: T;
  loading: boolean;
  failed: boolean;
}

/** Loads with `load` whenever `key` changes; data of another key is dropped, not shown stale. */
function useLoad<T>(key: string | undefined, load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T> & { key?: string }>({ loading: true, failed: false });
  useEffect(() => {
    if (key === undefined) return;
    const controller = new AbortController();
    setLoaded((current) => ({ ...(current.key?.split('#')[0] === key.split('#')[0] ? current : {}), key, loading: true, failed: false }));
    load(controller.signal).then(
      (data) => setLoaded({ key, data, loading: false, failed: false }),
      (err) => {
        if (controller.signal.aborted) return;
        console.warn(`Could not load ${key}`, err);
        setLoaded((current) => ({ ...current, loading: false, failed: true }));
      },
    );
    return () => controller.abort();
    // `key` identifies what `load` loads, so it is the only dependency
  }, [key]);
  return loaded;
}

const formatDate = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const DateCell = ({ iso }: { iso?: string }) => (iso ? <time dateTime={iso}>{formatDate.format(new Date(iso))}</time> : <>—</>);

const matches = (api: ApiGateway, query: string) =>
  [api.name, api.id, api.type, ...api.stages].some((value) => value.toLowerCase().includes(query));

const typeLabel = { REST: 'REST API', HTTP: 'HTTP API', WEBSOCKET: 'WebSocket API' };

/** Until the dashboard has sign-in, nobody should be able to roll back an API from a public page. */
const ROLLBACK_DISABLED = 'Rolling back from the dashboard comes with sign-in. Use the api-gateway restore workflow for now.';

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
        state={list.loading ? 'loading' : list.failed ? 'error' : 'ready'}
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
  // refreshing the list reloads the selected API too
  const details = useLoad<ApiGatewayDetails>(`${api.type}:${api.id}#${reloads}`, (signal) => fetchApiGatewayDetails(api, signal));
  const data = details.data;

  const message: TableMessage | undefined = details.failed && !data
    ? { text: `Could not load ${api.name}. Try refreshing.`, error: true }
    : !data ? { text: 'Loading…' } : undefined;

  return (
    <DetailPanel
      id="api-gateway-details" icon="apiGateway" tint="tint-api" name={api.name}
      badge={api.stages.length ? 'Deployed' : undefined}
      subtitle={<>{api.id} &nbsp; {typeLabel[api.type]}</>}
      tabs={['Stages', 'Deployments', 'Configuration']}
      state={details.loading ? 'loading' : details.failed ? 'error' : 'ready'}
    >
      {(tab) => {
        if (tab === 'Stages') {
          return (
            <DataTable rows={data?.stages ?? []} rowKey={(s) => s.name}
              message={message ?? (data!.stages.length ? undefined : { text: 'No stages: this API was never deployed.' })}
              columns={[
                { header: 'Stage Name', cell: (s) => <><span className={`dot ${s.deploymentId ? 'ok' : 'muted'}`} />{s.name}</> },
                { header: 'Deployment ID', cell: (s) => s.deploymentId ?? '—' },
                { header: 'Deployed At', cell: (s) => <DateCell iso={s.deployedAt} /> },
                { header: 'Actions', cell: () => <RollbackButton disabledReason={ROLLBACK_DISABLED} /> },
              ]} />
          );
        }
        if (tab === 'Deployments') {
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
  );
}
