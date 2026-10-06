// The three service rows of the dashboard, on sample data (mock-data.ts).
import {
  apis, apiStages, distributionDeployments, distributions, lambdas, lambdaVersions,
} from '../mock-data.js';
import { DetailPanel, ListPanel } from './Panels.js';
import { DataTable, EnvTags, MoreButton, NameLink, RollbackButton, RowChevron, Status } from './ui.js';

export function ApiGatewaySection() {
  return (
    <div className="panel-row">
      <ListPanel id="api-gateways" icon="apiGateway" tint="tint-api" title="API Gateways" searchPlaceholder="Search APIs..."
        description="View your API Gateway APIs, stages and deployments. Rollback to a previous deployment.">
        <DataTable rows={apis} rowKey={(a) => a.id} selectedKey={apis[0].id} columns={[
          { header: 'Name', cell: (a) => <NameLink name={a.name} /> },
          { header: 'API ID', cell: (a) => a.id },
          { header: 'Type', cell: (a) => a.type },
          { header: 'Stages', cell: (a) => <EnvTags envs={a.stages} /> },
          { header: 'Last Deployed', cell: (a) => a.lastDeployed },
          { header: '', cell: () => <RowChevron /> },
        ]} />
      </ListPanel>
      <DetailPanel icon="apiGateway" tint="tint-api" name="farm-management-api" badge="Active"
        subtitle={<>a1b2c3d4e5 &nbsp; REST API</>} tabs={['Stages', 'Deployments', 'Configuration']}>
        <DataTable rows={apiStages} rowKey={(s) => s.stage} columns={[
          { header: 'Stage Name', cell: (s) => <NameLink name={s.stage} healthy={s.healthy} /> },
          { header: 'Deployment ID', cell: (s) => s.deploymentId },
          { header: 'Deployed At', cell: (s) => s.deployedAt },
          { header: 'Actions', cell: () => <RollbackButton /> },
          { header: '', cell: () => <MoreButton /> },
        ]} />
      </DetailPanel>
    </div>
  );
}

export function LambdaSection() {
  return (
    <div className="panel-row">
      <ListPanel id="lambda-functions" icon="lambda" tint="tint-lambda" title="Lambda Functions" searchPlaceholder="Search functions..."
        description="View your Lambda functions, versions and aliases. Rollback to a previous version.">
        <DataTable rows={lambdas} rowKey={(l) => l.name} selectedKey={lambdas[0].name} columns={[
          { header: 'Function Name', cell: (l) => <NameLink name={l.name} /> },
          { header: 'Function ARN', cell: (l) => <span title={l.arn}>{l.arn}</span>, className: 'truncate small' },
          { header: 'Runtime', cell: (l) => l.runtime },
          { header: 'Aliases', cell: (l) => <EnvTags envs={l.aliases} /> },
          { header: 'Last Modified', cell: (l) => l.lastModified },
          { header: '', cell: () => <RowChevron /> },
        ]} />
      </ListPanel>
      <DetailPanel icon="lambda" tint="tint-lambda" name="farm-api-handler" badge="Active"
        subtitle="arn:aws:lambda:...:function:farm-api-handler" tabs={['Versions', 'Aliases', 'Configuration', 'Monitoring']}>
        <DataTable rows={lambdaVersions} rowKey={(v) => v.version} columns={[
          { header: 'Version', cell: (v) => <a href="#">{v.version}</a> },
          { header: 'Description', cell: (v) => v.description, className: 'wrap' },
          { header: 'Published At', cell: (v) => v.publishedAt },
          { header: 'Actions', cell: () => <RollbackButton /> },
          { header: '', cell: () => <MoreButton /> },
        ]} />
      </DetailPanel>
    </div>
  );
}

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
