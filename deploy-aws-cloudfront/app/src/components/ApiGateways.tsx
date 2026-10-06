// API Gateways: the region's APIs from the dashboard API, with search and refresh.
import { useEffect, useMemo, useState } from 'react';
import { fetchApiGateways, type ApiGateway, type ApiGatewayList } from '../api.js';
import { ListPanel } from './Panels.js';
import { DataTable, StageTags, type TableMessage } from './ui.js';

interface Loaded {
  /** the last list that loaded; kept on screen while refreshing */
  list?: ApiGatewayList;
  loading: boolean;
  failed: boolean;
}

function useApiGateways() {
  const [loaded, setLoaded] = useState<Loaded>({ loading: true, failed: false });
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded((current) => ({ ...current, loading: true }));
    fetchApiGateways(controller.signal).then(
      (list) => setLoaded({ list, loading: false, failed: false }),
      (err) => {
        if (controller.signal.aborted) return;
        console.warn('Could not load the API Gateways', err);
        setLoaded((current) => ({ ...current, loading: false, failed: true }));
      },
    );
    return () => controller.abort();
  }, [reloads]);
  return { ...loaded, refresh: () => setReloads((n) => n + 1) };
}

const formatDate = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const matches = (api: ApiGateway, query: string) =>
  [api.name, api.id, api.type, ...api.stages].some((value) => value.toLowerCase().includes(query));

export function ApiGatewaySection() {
  const { list, loading, failed, refresh } = useApiGateways();
  const [query, setQuery] = useState('');
  const apis = list?.apis ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? apis.filter((api) => matches(api, q)) : apis;
  }, [apis, query]);

  let message: TableMessage | undefined;
  if (failed && !list) message = { text: 'Could not load the API Gateways. Try refreshing.', error: true };
  else if (!list) message = { text: 'Loading API Gateways…' };
  else if (!apis.length) message = { text: `No API Gateways in ${list.region}.` };
  else if (!shown.length) message = { text: `No API Gateways match “${query.trim()}”.` };

  const state = loading ? 'loading' : failed ? 'error' : 'ready';
  return (
    <ListPanel
      id="api-gateways" icon="apiGateway" tint="tint-api" title="API Gateways" state={state}
      count={list && (shown.length === apis.length ? `${apis.length}` : `${shown.length} of ${apis.length}`)}
      description={`The REST, HTTP and WebSocket APIs${list ? ` in ${list.region}` : ''}, with their stages and latest deployment.`}
      searchPlaceholder="Search APIs..." search={{ value: query, onChange: setQuery }}
      onRefresh={refresh} refreshing={loading}
    >
      {/* the list stays while a refresh fails: say so above it */}
      {failed && list && <p className="refresh-error" role="alert">Refresh failed, showing the last list loaded.</p>}
      <DataTable rows={shown} rowKey={(api) => api.id} message={message} columns={[
        { header: 'Name', cell: (api) => <><span className={`dot ${api.stages.length ? 'ok' : 'muted'}`} />{api.name}</> },
        { header: 'API ID', cell: (api) => api.id },
        { header: 'Type', cell: (api) => api.type },
        { header: 'Stages', cell: (api) => (api.stages.length ? <StageTags stages={api.stages} /> : '—') },
        {
          header: 'Last Deployed',
          cell: (api) => (api.lastDeployed ? <time dateTime={api.lastDeployed}>{formatDate.format(new Date(api.lastDeployed))}</time> : '—'),
        },
      ]} />
    </ListPanel>
  );
}
