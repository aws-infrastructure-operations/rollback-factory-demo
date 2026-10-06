import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

interface ServiceIconProps { icon: IconName; tint: string }
const ServiceIcon = ({ icon, tint }: ServiceIconProps) => (
  <span className={`service-icon ${tint}`}><Icon name={icon} size={28} /></span>
);

/** Left column: a service's resources, with search and refresh (visual only for now). */
export function ListPanel({ id, icon, tint, title, description, searchPlaceholder, children }: ServiceIconProps & {
  id: string;
  title: string;
  description: string;
  searchPlaceholder: string;
  children: ReactNode;
}) {
  return (
    <section className="panel" id={id} aria-labelledby={`${id}-title`}>
      <div className="panel-header">
        <ServiceIcon icon={icon} tint={tint} />
        <div className="panel-title">
          <h2 id={`${id}-title`}>{title}</h2>
          <p>{description}</p>
        </div>
        <div className="panel-tools">
          <label className="search">
            <Icon name="search" size={16} />
            <input type="search" placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
          </label>
          <button type="button" className="icon-button" aria-label="Refresh"><Icon name="refresh" size={16} /></button>
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
