// Sample data for the CloudFront panels. Nothing here comes from AWS: the panels only show what the
// UI will look like once they are wired to real data (API Gateways and Lambda already are).

export interface DistributionRow { name: string; id: string; domain: string; status: string; lastDeployed: string }

export const distributions: DistributionRow[] = [
  { name: 'farm-frontend', id: 'E1A2B3C4D5E6F7', domain: 'd111111abcdef8.cloudfront.net', status: 'Deployed', lastDeployed: 'Oct 6, 2026 15:12' },
  { name: 'admin-portal', id: 'E2B3C4D5E6F7G8', domain: 'd222222abcdef8.cloudfront.net', status: 'Deployed', lastDeployed: 'Oct 5, 2026 11:20' },
  { name: 'detection-frontend', id: 'E3C4D5E6F7G8H9', domain: 'd333333abcdef8.cloudfront.net', status: 'Deployed', lastDeployed: 'Oct 4, 2026 09:58' },
  { name: 'heal-frontend', id: 'E4D5E6F7G8H9I0', domain: 'd444444abcdef8.cloudfront.net', status: 'Deployed', lastDeployed: 'Oct 2, 2026 14:23' },
];

export const distributionDeployments = [
  { version: 'v28', description: 'Update web assets', deployedAt: 'Oct 6, 2026 15:12' },
  { version: 'v27', description: 'Fix UI bug', deployedAt: 'Oct 5, 2026 10:45' },
  { version: 'v26', description: 'New release', deployedAt: 'Oct 3, 2026 18:20' },
  { version: 'v25', description: 'Previous stable version', deployedAt: 'Oct 1, 2026 13:10' },
];
