// The dashboard layout (development/dashboard.png). API Gateways load from the dashboard API;
// Lambda and CloudFront are still sample data, and no action does anything yet.
// It also shows which environment and release this site is, so an activation or a rollback is visible.
import type { AppConfig } from './config.js';
import { ApiGatewaySection } from './components/ApiGateways.js';
import { CloudFrontSection, LambdaSection } from './components/Sections.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';

export function App({ config }: { config: AppConfig }) {
  const built = config.builtAt ? new Date(config.builtAt).toUTCString() : 'local build';
  return (
    <div className="layout">
      <Sidebar config={config} />
      <div className="content">
        <TopBar lastUpdated={built} />
        <main className="panels">
          <ApiGatewaySection />
          <LambdaSection />
          <CloudFrontSection />
        </main>
        <footer className="page-footer">Release <span id="footer-release">{config.releaseId}</span></footer>
      </div>
    </div>
  );
}
