// The CloudFront row of the dashboard, still on sample data (mock-data.ts).
// API Gateways and Lambda functions load real data: see ApiGateways.tsx and LambdaFunctions.tsx.
import { distributionDeployments, distributions } from '../mock-data.js';
import { DetailPanel, ListPanel } from './Panels.js';
import { DataTable, MoreButton, NameLink, RollbackButton, RowChevron, Status } from './ui.js';

export function CloudFrontSection() {
  return (
    <div className="panel-row">
      <ListPanel id="cloudfront-distributions" icon="globe" tint="tint-cloudfront" title="CloudFront Distributions"
        searchPlaceholder="Search distributions..."
        description="View your CloudFront distributions and deployment history. Rollback to a previous version.">
        <DataTable rows={distributions} rowKey={(d) => d.id} selectedKey={distributions[0].id} columns={[
          { header: 'Distribution Name', cell: (d) => <NameLink name={d.name} /> },
          { header: 'Distribution ID', cell: (d) => d.id },
          { header: 'Domain Name', cell: (d) => d.domain },
          { header: 'Status', cell: (d) => <Status>{d.status}</Status> },
          { header: 'Last Deployed', cell: (d) => d.lastDeployed },
          { header: '', cell: () => <RowChevron /> },
        ]} />
      </ListPanel>
      <DetailPanel icon="globe" tint="tint-cloudfront" name="farm-frontend" badge="Deployed"
        subtitle="d111111abcdef8.cloudfront.net" tabs={['Deployments', 'Configuration', 'Invalidations', 'Monitoring']}>
        <DataTable rows={distributionDeployments} rowKey={(d) => d.version} columns={[
          { header: 'Version', cell: (d) => <a href="#">{d.version}</a> },
          { header: 'Description', cell: (d) => d.description, className: 'wrap' },
          { header: 'Deployed At', cell: (d) => d.deployedAt },
          { header: 'Actions', cell: () => <RollbackButton /> },
          { header: '', cell: () => <MoreButton /> },
        ]} />
      </DetailPanel>
    </div>
  );
}
