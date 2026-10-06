// Lambda Functions: the region's functions from the dashboard API, with search and refresh, and
// the selected function's versions, aliases, configuration and last 24 hours next to them.
import { useMemo, useState } from 'react';
import {
  fetchLambdaFunctionDetails, fetchLambdaFunctionMetrics, fetchLambdaFunctions,
  type LambdaFunction, type LambdaFunctionDetails, type LambdaFunctionList, type LambdaFunctionMetrics,
} from '../api.js';
import { DateCell, loadState, useLoad, type Loaded } from './loading.js';
import { DetailPanel, ListPanel } from './Panels.js';
import { DataTable, RollbackButton, StageTags, type TableMessage } from './ui.js';

/** Until the dashboard has sign-in, nobody should be able to roll back a function from a public page. */
const ROLLBACK_DISABLED = 'Rolling back from the dashboard comes with sign-in. Use the lambda rollback-by-version workflow for now.';

const matches = (fn: LambdaFunction, query: string) =>
  [fn.name, fn.runtime, fn.description ?? '', ...fn.aliases].some((value) => value.toLowerCase().includes(query));

/** The message row of a table while its data is missing, else undefined. */
const pendingMessage = (loaded: Loaded<unknown>, what: string): TableMessage | undefined =>
  loaded.failed && !loaded.data ? { text: `Could not load ${what}. Try refreshing.`, error: true }
    : !loaded.data ? { text: 'Loading…' } : undefined;

export function LambdaSection() {
  const [reloads, setReloads] = useState(0);
  const list = useLoad<LambdaFunctionList>(`list#${reloads}`, (signal) => fetchLambdaFunctions(signal));
  const [query, setQuery] = useState('');
  const [selectedName, setSelectedName] = useState<string>();

  const functions = list.data?.functions ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? functions.filter((fn) => matches(fn, q)) : functions;
  }, [functions, query]);
  // the clicked function while it is listed, else the first one shown
  const selected = shown.find((fn) => fn.name === selectedName) ?? shown[0];

  let message = pendingMessage(list, 'the Lambda functions');
  if (list.data && !functions.length) message = { text: `No Lambda functions in ${list.data.region}.` };
  else if (list.data && !shown.length) message = { text: `No Lambda functions match “${query.trim()}”.` };

  return (
    <div className="panel-row">
      <ListPanel
        id="lambda-functions" icon="lambda" tint="tint-lambda" title="Lambda Functions" state={loadState(list)}
        count={list.data && (shown.length === functions.length ? `${functions.length}` : `${shown.length} of ${functions.length}`)}
        description={`The functions${list.data ? ` in ${list.data.region}` : ''}, with their aliases and latest change.`}
        searchPlaceholder="Search functions..." search={{ value: query, onChange: setQuery }}
        onRefresh={() => setReloads((n) => n + 1)} refreshing={list.loading}
      >
        {list.failed && list.data && <p className="refresh-error" role="alert">Refresh failed, showing the last list loaded.</p>}
        <DataTable rows={shown} rowKey={(fn) => fn.name} message={message}
          selectedKey={selected?.name} onSelect={(fn) => setSelectedName(fn.name)} columns={[
            {
              header: 'Function Name',
              cell: (fn) => (
                <>
                  <span className={`dot ${fn.aliases.length ? 'ok' : 'muted'}`} />
                  <button type="button" className="link-button" aria-pressed={fn.name === selected?.name} title={fn.arn}
                    onClick={(e) => { e.stopPropagation(); setSelectedName(fn.name); }}>
                    {fn.name}
                  </button>
                </>
              ),
            },
            { header: 'Runtime', cell: (fn) => fn.runtime },
            { header: 'Aliases', cell: (fn) => (fn.aliases.length ? <StageTags stages={fn.aliases} /> : '—') },
            { header: 'Last Modified', cell: (fn) => <DateCell iso={fn.lastModified} /> },
          ]} />
      </ListPanel>
      {selected
        ? <LambdaDetailPanel fn={selected} reloads={reloads} />
        : <section className="panel detail placeholder" aria-label="Function details"><p>{functions.length ? 'No function selected.' : 'No function to show.'}</p></section>}
    </div>
  );
}

const percent = (weight: number) => `${Math.round(weight * 100)}%`;

/** "2", or "2 (90%) + 10 (10%)" for a weighted alias. */
function aliasTarget({ version, additionalVersions }: LambdaFunctionDetails['aliases'][number]) {
  const extra = Object.entries(additionalVersions ?? {});
  if (!extra.length) return version;
  const rest = extra.reduce((total, [, weight]) => total - weight, 1);
  return [`${version} (${percent(rest)})`, ...extra.map(([v, weight]) => `${v} (${percent(weight)})`)].join(' + ');
}

function LambdaDetailPanel({ fn, reloads }: { fn: LambdaFunction; reloads: number }) {
  // refreshing the list reloads the selected function too
  const details = useLoad<LambdaFunctionDetails>(`${fn.name}#${reloads}`, (signal) => fetchLambdaFunctionDetails(fn.name, signal));
  const data = details.data;
  const message = pendingMessage(details, fn.name);

  return (
    <DetailPanel
      id="lambda-function-details" icon="lambda" tint="tint-lambda" name={fn.name}
      badge={fn.aliases.length ? 'Active' : undefined}
      subtitle={<span title={fn.arn}>{data?.arn ?? fn.arn}</span>}
      tabs={['Versions', 'Aliases', 'Configuration', 'Monitoring']}
      state={loadState(details)}
    >
      {(tab) => {
        if (tab === 'Versions') {
          return (
            <DataTable rows={data?.versions ?? []} rowKey={(v) => v.version}
              message={message ?? (data!.versions.length ? undefined : { text: 'No published versions: only $LATEST.' })}
              columns={[
                // the aliases serving a version go under it, to keep the table narrow
                { header: 'Version', cell: (v) => <div className="stacked">{v.version}{v.aliases.length > 0 && <StageTags stages={v.aliases} />}</div> },
                { header: 'Description', cell: (v) => v.description || '—', className: 'wrap' },
                { header: 'Published At', cell: (v) => <DateCell iso={v.publishedAt} />, className: 'date-wrap' },
                { header: 'Actions', cell: () => <RollbackButton disabledReason={ROLLBACK_DISABLED} /> },
              ]} />
          );
        }
        if (tab === 'Aliases') {
          return (
            <DataTable rows={data?.aliases ?? []} rowKey={(a) => a.name}
              message={message ?? (data!.aliases.length ? undefined : { text: 'No aliases.' })}
              columns={[
                { header: 'Alias', cell: (a) => <StageTags stages={[a.name]} /> },
                { header: 'Version', cell: aliasTarget },
                { header: 'Description', cell: (a) => a.description || '—', className: 'wrap' },
              ]} />
          );
        }
        if (tab === 'Monitoring') return <LambdaMetrics name={fn.name} reloads={reloads} />;
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

/** Loaded only when the Monitoring tab is open: every GetMetricData call is billed. */
function LambdaMetrics({ name, reloads }: { name: string; reloads: number }) {
  const metrics = useLoad<LambdaFunctionMetrics>(`${name}#${reloads}`, (signal) => fetchLambdaFunctionMetrics(name, signal));
  const m = metrics.data;
  const message = pendingMessage(metrics, `the metrics of ${name}`);
  if (message || !m) return <DataTable rows={[]} rowKey={() => ''} message={message} columns={[{ header: 'Last 24 hours', cell: () => null }]} />;

  const ms = (value?: number) => (value === undefined ? '—' : `${value.toLocaleString('en-US')} ms`);
  const errorRate = m.invocations ? ` (${((m.errors / m.invocations) * 100).toFixed(1)}%)` : '';
  const tiles: Array<[string, string, boolean?]> = [
    ['Invocations', m.invocations.toLocaleString('en-US')],
    ['Errors', `${m.errors.toLocaleString('en-US')}${errorRate}`, m.errors > 0],
    ['Throttles', m.throttles.toLocaleString('en-US'), m.throttles > 0],
    ['Avg duration', ms(m.averageDuration)],
    ['Max duration', ms(m.maxDuration)],
    ['Max concurrency', m.maxConcurrency === undefined ? '—' : String(m.maxConcurrency)],
  ];
  return (
    <div data-state={loadState(metrics)} className="metrics">
      <p className="metrics-range">Last 24 hours, all versions and aliases.</p>
      <dl className="metric-tiles">
        {tiles.map(([label, value, bad]) => (
          <div key={label} className={bad ? 'bad' : undefined}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </div>
  );
}
