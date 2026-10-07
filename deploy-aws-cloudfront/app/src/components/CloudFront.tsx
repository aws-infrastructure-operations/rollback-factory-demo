// CloudFront Distributions: the account's distributions from the dashboard API, with search and
// refresh, and the selected one's release history, configuration, invalidations and last 24 hours.
import { useMemo, useState } from 'react';
import {
  fetchDistributionDetails, fetchDistributionInvalidations, fetchDistributionMetrics, fetchDistributions,
  type Distribution, type DistributionDetails, type DistributionInvalidation, type DistributionMetrics,
} from '../api.js';
import { DateCell, loadState, pendingMessage, useLoad } from './loading.js';
import { DetailPanel, ListPanel } from './Panels.js';
import { DataTable, RollbackButton, type TableMessage } from './ui.js';

/** Until the dashboard has sign-in, nobody should be able to roll back a site from a public page. */
const ROLLBACK_DISABLED = 'Rolling back from the dashboard comes with sign-in. Use the frontend restore workflow for now.';

const matches = (d: Distribution, query: string) =>
  [d.name, d.id, d.domain, d.status, d.releaseId ?? '', ...d.aliases].some((value) => value.toLowerCase().includes(query));

const StatusBadge = ({ d }: { d: Pick<Distribution, 'status' | 'enabled'> }) => {
  if (!d.enabled) return <span className="status muted">Disabled</span>;
  return <span className={`status${d.status === 'Deployed' ? '' : ' pending'}`}>{d.status === 'InProgress' ? 'In progress' : d.status}</span>;
};

const Tag = ({ kind, children }: { kind: 'prod' | 'staging' | 'dev' | 'bad'; children: string }) => (
  <span className={`tag tag-${kind}`}>{children}</span>
);

export function CloudFrontSection() {
  const [reloads, setReloads] = useState(0);
  const list = useLoad(`list#${reloads}`, (signal) => fetchDistributions(signal));
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();

  const distributions = list.data?.distributions ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? distributions.filter((d) => matches(d, q)) : distributions;
  }, [distributions, query]);
  // the clicked distribution while it is listed, else the first one shown
  const selected = shown.find((d) => d.id === selectedId) ?? shown[0];

  let message = pendingMessage(list, 'the CloudFront distributions');
  if (list.data && !distributions.length) message = { text: 'No CloudFront distributions in this account.' };
  else if (list.data && !shown.length) message = { text: `No distributions match “${query.trim()}”.` };

  return (
    <div className="panel-row">
      <ListPanel
        id="cloudfront-distributions" icon="globe" tint="tint-cloudfront" title="CloudFront Distributions" state={loadState(list)}
        count={list.data && (shown.length === distributions.length ? `${distributions.length}` : `${shown.length} of ${distributions.length}`)}
        description="The account's distributions, with their status and the release this project's sites serve."
        searchPlaceholder="Search distributions..." search={{ value: query, onChange: setQuery }}
        onRefresh={() => setReloads((n) => n + 1)} refreshing={list.loading}
      >
        {list.failed && list.data && <p className="refresh-error" role="alert">Refresh failed, showing the last list loaded.</p>}
        <DataTable rows={shown} rowKey={(d) => d.id} message={message}
          selectedKey={selected?.id} onSelect={(d) => setSelectedId(d.id)} columns={[
            {
              header: 'Distribution Name',
              // the id goes under the name, to keep the table narrow
              cell: (d) => (
                <div className="name-with-id">
                  <span className={`dot ${d.enabled && d.status === 'Deployed' ? 'ok' : 'muted'}`} />
                  <div className="stacked">
                    <button type="button" className="link-button" aria-pressed={d.id === selected?.id}
                      onClick={(e) => { e.stopPropagation(); setSelectedId(d.id); }}>
                      {d.name}
                    </button>
                    {d.name !== d.id && <span className="small muted-text">{d.id}</span>}
                  </div>
                </div>
              ),
            },
            { header: 'Domain Name', cell: (d) => d.aliases[0] ?? d.domain },
            { header: 'Status', cell: (d) => <StatusBadge d={d} /> },
            { header: 'Last Modified', cell: (d) => <DateCell iso={d.lastModified} /> },
          ]} />
      </ListPanel>
      {selected
        ? <DistributionDetailPanel d={selected} reloads={reloads} />
        : <section className="panel detail placeholder" aria-label="Distribution details"><p>{distributions.length ? 'No distribution selected.' : 'No distribution to show.'}</p></section>}
    </div>
  );
}

function DistributionDetailPanel({ d, reloads }: { d: Distribution; reloads: number }) {
  // refreshing the list reloads the selected distribution too
  const details = useLoad<DistributionDetails>(`${d.id}#${reloads}`, (signal) => fetchDistributionDetails(d.id, signal));
  const data = details.data;
  const message = pendingMessage(details, d.name);

  return (
    <DetailPanel
      id="cloudfront-distribution-details" icon="globe" tint="tint-cloudfront" name={d.name}
      badge={d.enabled && d.status === 'Deployed' ? 'Deployed' : undefined}
      subtitle={d.releaseId ? <>{d.domain} &nbsp; release {d.releaseId}</> : d.domain}
      tabs={['Deployments', 'Configuration', 'Invalidations', 'Monitoring']}
      state={loadState(details)}
    >
      {(tab) => {
        if (tab === 'Deployments') {
          let deploymentsMessage: TableMessage | undefined = message;
          if (!deploymentsMessage && !data!.tracked) {
            deploymentsMessage = { text: 'No release history: only the frontend-user-<env> distributions keep one.' };
          } else if (!deploymentsMessage && !data!.deployments.length) {
            deploymentsMessage = { text: 'No release recorded yet.' };
          }
          return (
            <DataTable rows={data?.deployments ?? []} rowKey={(r) => r.deployedAt} message={deploymentsMessage} columns={[
              {
                header: 'Release',
                cell: (r) => (
                  <div className="stacked">
                    {r.releaseId}
                    {(r.current || r.rolledBack || r.verified) && (
                      <span className="tags">
                        {r.current && <Tag kind="prod">live</Tag>}
                        {r.verified && <Tag kind="staging">verified</Tag>}
                        {r.rolledBack && <Tag kind="bad">rolled back</Tag>}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                header: 'Source',
                cell: (r) => <div className="stacked">{r.source}{r.commit && <span className="small muted-text">{r.commit.slice(0, 7)}</span>}</div>,
              },
              { header: 'Deployed At', cell: (r) => <DateCell iso={r.deployedAt} />, className: 'date-wrap' },
              { header: 'Actions', cell: () => <RollbackButton disabledReason={ROLLBACK_DISABLED} /> },
            ]} />
          );
        }
        if (tab === 'Invalidations') return <Invalidations id={d.id} reloads={reloads} />;
        if (tab === 'Monitoring') return <DistributionMonitoring id={d.id} reloads={reloads} />;
        if (message) return <DataTable rows={[]} rowKey={() => ''} message={message} columns={[{ header: 'Setting', cell: () => null }]} />;
        return (
          <dl className="config-list">
            {data!.configuration.map(({ label, value }) => (
              <div key={label}><dt>{label}</dt><dd>{label === 'Last modified' ? <DateCell iso={value} /> : value}</dd></div>
            ))}
          </dl>
        );
      }}
    </DetailPanel>
  );
}

/** Loaded only when the tab is open: one GetInvalidation call per invalidation. */
function Invalidations({ id, reloads }: { id: string; reloads: number }) {
  const loaded = useLoad(`${id}#${reloads}`, (signal) => fetchDistributionInvalidations(id, signal));
  const rows: DistributionInvalidation[] = loaded.data?.invalidations ?? [];
  const message = pendingMessage(loaded, 'the invalidations') ?? (rows.length ? undefined : { text: 'No invalidations.' });
  return (
    <DataTable rows={rows} rowKey={(i) => i.id} message={message} columns={[
      { header: 'Invalidation', cell: (i) => <span className="small">{i.id}</span> },
      { header: 'Paths', cell: (i) => i.paths.join(', ') || '—', className: 'wrap' },
      { header: 'Status', cell: (i) => <span className={`status${i.status === 'Completed' ? '' : ' pending'}`}>{i.status}</span> },
      { header: 'Created', cell: (i) => <DateCell iso={i.createdAt} />, className: 'date-wrap' },
    ]} />
  );
}

const formatBytes = (bytes: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
};

/** Loaded only when the Monitoring tab is open: every GetMetricData call is billed. */
function DistributionMonitoring({ id, reloads }: { id: string; reloads: number }) {
  const metrics = useLoad<DistributionMetrics>(`${id}#${reloads}`, (signal) => fetchDistributionMetrics(id, signal));
  const m = metrics.data;
  const message = pendingMessage(metrics, 'the metrics');
  if (message || !m) return <DataTable rows={[]} rowKey={() => ''} message={message} columns={[{ header: 'Last 24 hours', cell: () => null }]} />;

  const rate = (value?: number) => (value === undefined ? '—' : `${value.toFixed(2)}%`);
  const tiles: Array<[string, string, boolean?]> = [
    ['Requests', m.requests.toLocaleString('en-US')],
    ['Data transferred', formatBytes(m.bytesDownloaded)],
    // any errors stand out; the rollback alarms' thresholds are per environment (lib/config.ts)
    ['4xx error rate', rate(m.error4xxRate), (m.error4xxRate ?? 0) > 0],
    ['5xx error rate', rate(m.error5xxRate), (m.error5xxRate ?? 0) > 0],
  ];
  return (
    <div data-state={loadState(metrics)} className="metrics">
      <p className="metrics-range">Last 24 hours; error rates are hourly averages.</p>
      <dl className="metric-tiles pairs">
        {tiles.map(([label, value, bad]) => (
          <div key={label} className={bad ? 'bad' : undefined}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </div>
  );
}
