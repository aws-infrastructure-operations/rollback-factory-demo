// Building blocks shared by the service sections: tables, tags, buttons.
import type { ReactNode } from 'react';
import type { Env } from '../mock-data.js';
import { Icon } from './Icon.js';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  /** e.g. 'wrap' for long descriptions, 'truncate' for ARNs */
  className?: string;
}

/** A row across the whole table instead of the data: loading, nothing found, or an error. */
export interface TableMessage { text: ReactNode; error?: boolean }

export function DataTable<T>({ columns, rows, rowKey, selectedKey, onSelect, message }: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selectedKey?: string;
  /** makes rows clickable (give one cell a button too, for the keyboard) */
  onSelect?: (row: T) => void;
  message?: TableMessage;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c, i) => <th key={i} scope="col">{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {message && (
            <tr>
              <td colSpan={columns.length} className={`state${message.error ? ' error' : ''}`} role={message.error ? 'alert' : 'status'}>
                {message.text}
              </td>
            </tr>
          )}
          {!message && rows.map((row) => (
            <tr key={rowKey(row)} onClick={onSelect && (() => onSelect(row))}
              className={[rowKey(row) === selectedKey && 'selected', onSelect && 'clickable'].filter(Boolean).join(' ') || undefined}>
              {columns.map((c, i) => <td key={i} className={c.className}>{c.cell(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const EnvTags = ({ envs }: { envs: Env[] }) => (
  <span className="tags">{envs.map((e) => <span key={e} className={`tag tag-${e}`}>{e}</span>)}</span>
);

/** Stage names are free text: the usual ones get the env colors, any other is neutral. */
const stageTag = (stage: string) =>
  ({ prod: 'tag-prod', live: 'tag-prod', staging: 'tag-staging', integration: 'tag-staging' })[stage] ?? 'tag-dev';

export const StageTags = ({ stages }: { stages: string[] }) => (
  <span className="tags">{stages.map((s) => <span key={s} className={`tag ${stageTag(s)}`}>{s}</span>)}</span>
);

export const NameLink = ({ name, healthy = true }: { name: string; healthy?: boolean }) => (
  <><span className={`dot ${healthy ? 'ok' : 'muted'}`} /><a href="#">{name}</a></>
);

export const RollbackButton = ({ disabledReason }: { disabledReason?: string }) => (
  <button type="button" className="rollback" disabled={!!disabledReason} title={disabledReason}>
    <Icon name="rollback" size={14} />Rollback
  </button>
);

export const MoreButton = () => (
  <button type="button" className="icon-button ghost" aria-label="More actions"><Icon name="more" size={16} /></button>
);

export const RowChevron = () => <span className="row-chevron"><Icon name="chevronRight" size={16} /></span>;

export const Status = ({ children }: { children: ReactNode }) => <span className="status">{children}</span>;
