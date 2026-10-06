import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

interface ServiceIconProps { icon: IconName; tint: string }
const ServiceIcon = ({ icon, tint }: ServiceIconProps) => (
  <span className={`service-icon ${tint}`}><Icon name={icon} size={28} /></span>
);

/**
 * A service's resources, with search and refresh. Without `search` / `onRefresh` the controls
 * are visual only (the sections still on sample data).
 */
export function ListPanel({
  id, icon, tint, title, count, description, searchPlaceholder, search, onRefresh, refreshing, state, children,
}: ServiceIconProps & {
  id: string;
  title: string;
  /** shown next to the title, e.g. "3 of 5" */
  count?: string;
  description: string;
  searchPlaceholder: string;
  search?: { value: string; onChange: (value: string) => void };
  onRefresh?: () => void;
  refreshing?: boolean;
  /** data-state, for tests: 'loading', 'ready' or 'error' */
  state?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel" id={id} aria-labelledby={`${id}-title`} data-state={state}>
      <div className="panel-header">
        <ServiceIcon icon={icon} tint={tint} />
        <div className="panel-title">
          <h2 id={`${id}-title`}>{title}{count && <span className="count">{count}</span>}</h2>
          <p>{description}</p>
        </div>
        <div className="panel-tools">
          <label className="search">
            <Icon name="search" size={16} />
            <input type="search" placeholder={searchPlaceholder} aria-label={searchPlaceholder}
              value={search?.value} onChange={search && ((e) => search.onChange(e.target.value))} />
          </label>
          <button type="button" className="icon-button" aria-label="Refresh" onClick={onRefresh} disabled={refreshing}>
            <Icon name="refresh" size={16} />
          </button>
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * Right column: the selected resource. The tabs only change which one is highlighted for now;
 * every tab shows the first tab's table until the panels get real data.
 */
export function DetailPanel({ icon, tint, name, badge, subtitle, tabs, children }: ServiceIconProps & {
  name: string;
  badge: string;
  subtitle: ReactNode;
  tabs: string[];
  children: ReactNode;
}) {
  const [active, setActive] = useState(tabs[0]);
  return (
    <section className="panel detail" aria-label={`${name} details`}>
      <div className="panel-header">
        <ServiceIcon icon={icon} tint={tint} />
        <div className="panel-title">
          <h2>{name} <span className="badge"><Icon name="check" size={12} />{badge}</span></h2>
          <p className="subtitle">{subtitle}</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={tab === active}
            className={`tab${tab === active ? ' active' : ''}`} onClick={() => setActive(tab)}>
            {tab}
          </button>
        ))}
      </div>
      {children}
    </section>
  );
}
