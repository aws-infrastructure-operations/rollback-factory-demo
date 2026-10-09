// The dashboard layout (development/dashboard.png): API Gateways, Lambda functions, CloudFront
// distributions and CloudFormation stacks, from the dashboard API (/api/*).
// It also shows which environment and release this site is, so an activation or a rollback is visible.
import type { AppConfig } from './config.js';
import { useRegion } from './region.js';
import { ApiGatewaySection } from './components/ApiGateways.js';
import { LambdaSection } from './components/LambdaFunctions.js';
import { CloudFrontSection } from './components/CloudFront.js';
import { CloudFormationSection } from './components/CloudFormation.js';
import { RollbacksSection } from './components/Rollbacks.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';

export function App({ config }: { config: AppConfig }) {
  const built = config.builtAt ? new Date(config.builtAt).toUTCString() : 'local build';
  // picking another region at the top starts the regional panels afresh (selection, search, data)
  const region = useRegion() ?? 'home';
  return (
    <div className="layout">
      <Sidebar config={config} />
      <div className="content">
        <TopBar lastUpdated={built} />
        <main className="panels">
          <ApiGatewaySection key={`api-gateways@${region}`} />
          <LambdaSection key={`lambda-functions@${region}`} />
          <CloudFrontSection />
          <CloudFormationSection />
          <RollbacksSection />
        </main>
        <footer className="page-footer">Release <span id="footer-release">{config.releaseId}</span></footer>
      </div>
    </div>
  );
}
