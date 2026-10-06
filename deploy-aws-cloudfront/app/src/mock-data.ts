// Sample data for the dashboard layout. Nothing here comes from AWS yet: the panels only show
// what the UI will look like once it is wired to the real APIs.

export type Env = 'prod' | 'staging' | 'dev';

export interface ApiRow { name: string; id: string; type: 'REST' | 'HTTP'; stages: Env[]; lastDeployed: string }
export interface LambdaRow { name: string; arn: string; runtime: string; aliases: Env[]; lastModified: string }
export interface DistributionRow { name: string; id: string; domain: string; status: string; lastDeployed: string }

export const apis: ApiRow[] = [
  { name: 'farm-management-api', id: 'a1b2c3d4e5', type: 'REST', stages: ['prod', 'staging', 'dev'], lastDeployed: 'Oct 6, 2026 14:32' },
  { name: 'auth-api', id: 'f6g7h8i9j0', type: 'HTTP', stages: ['prod', 'staging'], lastDeployed: 'Oct 5, 2026 11:18' },
  { name: 'detection-system-api', id: 'k1l2m3n4o5', type: 'REST', stages: ['prod', 'staging', 'dev'], lastDeployed: 'Oct 4, 2026 09:12' },
  { name: 'heal-system-api', id: 'p6q7r8s9t0', type: 'HTTP', stages: ['prod', 'staging'], lastDeployed: 'Oct 3, 2026 16:45' },
  { name: 'admin-api', id: 'u1v2w3x4y5', type: 'REST', stages: ['prod', 'staging'], lastDeployed: 'Oct 1, 2026 10:21' },
];

export const apiStages = [
  { stage: 'prod', deploymentId: 'd-0a1b2c3d4e', deployedAt: 'Oct 6, 2026 14:32', healthy: true },
  { stage: 'staging', deploymentId: 'd-5f6g7h8i9j', deployedAt: 'Oct 5, 2026 11:18', healthy: true },
  { stage: 'dev', deploymentId: 'd-1k2l3m4n5o', deployedAt: 'Oct 4, 2026 09:12', healthy: false },
];

const arn = (name: string) => `arn:aws:lambda:...function:${name}`;
export const lambdas: LambdaRow[] = [
  { name: 'farm-api-handler', arn: arn('farm-api-handler'), runtime: '.NET 8', aliases: ['prod', 'staging', 'dev'], lastModified: 'Oct 6, 2026 13:21' },
  { name: 'auth-handler', arn: arn('auth-handler'), runtime: 'Node.js 20', aliases: ['prod', 'staging'], lastModified: 'Oct 5, 2026 10:11' },
  { name: 'image-processor', arn: arn('image-processor'), runtime: 'Python 3.12', aliases: ['prod', 'staging'], lastModified: 'Oct 4, 2026 18:05' },
  { name: 'detection-worker', arn: arn('detection-worker'), runtime: 'Python 3.12', aliases: ['prod'], lastModified: 'Oct 2, 2026 09:44' },
  { name: 'heal-worker', arn: arn('heal-worker'), runtime: 'Node.js 20', aliases: ['prod', 'staging'], lastModified: 'Oct 1, 2026 16:30' },
];

export const lambdaVersions = [
  { version: '42', description: 'Bug fixes and performance improvements', publishedAt: 'Oct 6, 2026 13:21' },
  { version: '41', description: 'Add validation', publishedAt: 'Oct 5, 2026 09:10' },
  { version: '40', description: 'Feature: new endpoints', publishedAt: 'Oct 3, 2026 17:45' },
  { version: '39', description: 'Refactor services', publishedAt: 'Oct 1, 2026 12:33' },
];

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
