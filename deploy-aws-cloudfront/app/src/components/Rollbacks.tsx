// The rollback history: every rollback of the APIs, Lambda functions and sites, from the tables the
// rollback service records them in (GET /api/rollbacks). Read-only: filter by service, search, refresh.
import { useMemo, useState } from 'react';
import { fetchRollbacks, type RollbackEntry } from '../api.js';
import { DateCell, loadState, pendingMessage, useLoad } from './loading.js';
import { Icon, type IconName } from './Icon.js';
import { ListPanel } from './Panels.js';
import { DataTable } from './ui.js';

type Kind = RollbackEntry['kind'];
const KINDS: Array<{ kind: Kind; label: string; icon: IconName; tint: string }> = [
  { kind: 'api', label: 'API Gateway', icon: 'apiGateway', tint: 'tint-api' },
  { kind: 'lambda', label: 'Lambda', icon: 'lambda', tint: 'tint-lambda' },
  { kind: 'frontend', label: 'CloudFront', icon: 'globe', tint: 'tint-cloudfront' },
];
const kindOf = (kind: Kind) => KINDS.find((k) => k.kind === kind)!;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
/** "3 hours ago", "yesterday", ... */
function ago(iso: string) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

const matches = (r: RollbackEntry, q: string) =>
  [r.target, r.env, r.by, r.from, r.to, r.reason, kindOf(r.kind).label, r.trigger].some((v) => v?.toLowerCase().includes(q));

export function RollbacksSection() {
  const [reloads, setReloads] = useState(0);
  const list = useLoad(`rollbacks#${reloads}`, (signal) => fetchRollbacks(signal));
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind | 'all'>('all');

  const rollbacks = list.data?.rollbacks ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rollbacks.filter((r) => (kind === 'all' || r.kind === kind) && (!q || matches(r, q)));
  }, [rollbacks, query, kind]);
  const count = (k: Kind) => rollbacks.filter((r) => r.kind === k).length;
  const alarms = rollbacks.filter((r) => r.trigger === 'alarm').length;

  let message = pendingMessage(list, 'the rollbacks');
  if (list.data && !rollbacks.length) message = { text: 'No rollbacks yet: every deployment so far stayed healthy.' };
  else if (list.data && !shown.length) message = { text: 'No rollbacks match the filter.' };

  return (
    <ListPanel
      id="rollbacks" icon="rollback" tint="tint-rollback" title="Rollbacks" state={loadState(list)}
      count={list.data && (shown.length === rollbacks.length ? `${rollbacks.length}` : `${shown.length} of ${rollbacks.length}`)}
      description="Every rollback the rollback service made, in dev and prod: by an alarm, or by hand from here or a workflow."
      searchPlaceholder="Search rollbacks..." search={{ value: query, onChange: setQuery }}
      onRefresh={() => setReloads((n) => n + 1)} refreshing={list.loading}
    >
      {list.failed && list.data && <p className="refresh-error" role="alert">Refresh failed, showing the last list loaded.</p>}

      {list.data && rollbacks.length > 0 && (
        <div className="rollback-summary" aria-label="Rollbacks by service">
          <button type="button" className={`rollback-filter${kind === 'all' ? ' active' : ''}`} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
            <span className="rollback-filter-count">{rollbacks.length}</span>All
            <span className="muted-text">· {alarms} by alarm</span>
          </button>
          {KINDS.map((k) => (
            <button key={k.kind} type="button" className={`rollback-filter${kind === k.kind ? ' active' : ''}`}
              aria-pressed={kind === k.kind} onClick={() => setKind(kind === k.kind ? 'all' : k.kind)}>
              <span className={`rollback-kind-icon ${k.tint}`}><Icon name={k.icon} size={14} /></span>
              <span className="rollback-filter-count">{count(k.kind)}</span>{k.label}
            </button>
          ))}
        </div>
      )}

      <DataTable rows={shown} rowKey={(r) => `${r.kind}:${r.target}:${r.at}`} message={message} columns={[
        {
          header: 'When',
          cell: (r) => <div className="stacked"><DateCell iso={r.at} /><span className="muted-text">{ago(r.at)}</span></div>,
          className: 'date-wrap',
        },
        {
          header: 'Service',
          cell: (r) => (
            <div className="name-with-id">
              <span className={`rollback-kind-icon ${kindOf(r.kind).tint}`}><Icon name={kindOf(r.kind).icon} size={14} /></span>
              <div className="stacked">
                <span>{r.target}</span>
                <span className={`tag ${r.env === 'prod' ? 'tag-prod' : 'tag-dev'}`}>{r.env}</span>
              </div>
            </div>
          ),
        },
        {
          header: 'Change',
          cell: (r) => (
            <span className="rollback-change">
              <span className="rollback-from" title="replaced">{r.from ?? '?'}</span>
              <Icon name="chevronRight" size={14} />
              <span className="rollback-to" title="went back to">{r.to ?? '?'}</span>
            </span>
          ),
        },
        {
          header: 'Trigger',
          cell: (r) => (
            <div className="stacked">
              <span className={`tag ${r.trigger === 'alarm' ? 'tag-bad' : 'tag-staging'}`}>{r.trigger === 'alarm' ? 'alarm' : 'manual'}</span>
              <span className="muted-text rollback-by" title={r.by}>{r.by}</span>
            </div>
          ),
          className: 'wrap',
        },
        { header: 'Reason', cell: (r) => r.reason || <span className="muted-text">—</span>, className: 'wrap' },
      ]} />
    </ListPanel>
  );
}
