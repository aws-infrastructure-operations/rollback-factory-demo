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

export function DataTable<T>({ columns, rows, rowKey, selectedKey }: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selectedKey?: string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c, i) => <th key={i} scope="col">{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={rowKey(row) === selectedKey ? 'selected' : undefined}>
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

export const NameLink = ({ name, healthy = true }: { name: string; healthy?: boolean }) => (
  <><span className={`dot ${healthy ? 'ok' : 'muted'}`} /><a href="#">{name}</a></>
);

export const RollbackButton = () => (
  <button type="button" className="rollback"><Icon name="rollback" size={14} />Rollback</button>
);

export const MoreButton = () => (
  <button type="button" className="icon-button ghost" aria-label="More actions"><Icon name="more" size={16} /></button>
);

export const RowChevron = () => <span className="row-chevron"><Icon name="chevronRight" size={16} /></span>;

export const Status = ({ children }: { children: ReactNode }) => <span className="status">{children}</span>;
