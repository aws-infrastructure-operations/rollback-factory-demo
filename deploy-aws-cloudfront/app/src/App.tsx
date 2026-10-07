// The dashboard layout (development/dashboard.png): API Gateways, Lambda functions and CloudFront
// distributions, from the dashboard API (/api/*). Read-only: no action does anything yet.
// It also shows which environment and release this site is, so an activation or a rollback is visible.
import type { AppConfig } from './config.js';
import { ApiGatewaySection } from './components/ApiGateways.js';
import { LambdaSection } from './components/LambdaFunctions.js';
import { CloudFrontSection } from './components/CloudFront.js';
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
