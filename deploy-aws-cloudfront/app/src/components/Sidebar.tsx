import type { AppConfig } from '../config.js';
import { Icon, type IconName } from './Icon.js';

const services: Array<{ label: string; href: string; icon: IconName; tint?: string; active?: boolean }> = [
  { label: 'Dashboard', href: '#', icon: 'home' },
  { label: 'API Gateway', href: '#api-gateways', icon: 'apiGateway', tint: 'tint-api', active: true },
  { label: 'Lambda', href: '#lambda-functions', icon: 'lambda', tint: 'tint-lambda' },
  { label: 'CloudFront', href: '#cloudfront-distributions', icon: 'globe', tint: 'tint-cloudfront' },
];

const environments = [
  { label: 'Production', active: true },
  { label: 'Staging' },
  { label: 'Development' },
];

/** Navigation (visual only for now) and which release this site serves. */
export function Sidebar({ config }: { config: AppConfig }) {
  const site = config.env === 'local' ? 'frontend-user' : `frontend-user-${config.env}`;
  return (
    <aside className="sidebar" aria-label="Navigation">
      <div className="brand"><Icon name="cube" />AWS Control Center</div>

      <nav className="nav" aria-label="Services">
        {services.map((s) => (
          <a key={s.label} href={s.href} className={`nav-item${s.active ? ' active' : ''}`} aria-current={s.active ? 'page' : undefined}>
            <span className={s.tint}><Icon name={s.icon} /></span>{s.label}
          </a>
        ))}
      </nav>

      <div className="nav-section">Environments</div>
      <nav className="nav" aria-label="Environments">
        {environments.map((e) => (
          <a key={e.label} href="#" className={`nav-item${e.active ? ' active' : ''}`}>
            <span className={`dot ${e.active ? 'ok' : 'muted'}`} />{e.label}
          </a>
        ))}
      </nav>

      <div className="sidebar-bottom">
        {/* which release the distribution serves: an activation or a rollback shows up here */}
        <dl className="build-info" aria-label="This site">
          <dt>Site</dt><dd id="name">{site}</dd>
          <dt>Environment</dt><dd id="env">{config.env}</dd>
          <dt>Release</dt><dd id="release">{config.releaseId}</dd>
        </dl>
        <a href="#" className="nav-item"><Icon name="settings" />Settings</a>
      </div>
    </aside>
  );
}
