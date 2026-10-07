// The dashboard API, served by the same distribution at /api/* (lambda/dashboard-api).
// `npm run app:dev` proxies /api to DASHBOARD_API_URL when it is set (see vite.config.ts).

/** Same shape as ApiGatewaySummary in lambda/dashboard-api/api-gateways.ts. */
export interface ApiGateway {
  id: string;
  name: string;
  type: 'REST' | 'HTTP' | 'WEBSOCKET';
  stages: string[];
  /** ISO 8601, absent when the API has no stages */
  lastDeployed?: string;
}

export interface ApiGatewayList {
  region: string;
  apis: ApiGateway[];
}

export async function fetchApiGateways(signal?: AbortSignal): Promise<ApiGatewayList> {
  const response = await fetch('/api/api-gateways', { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET /api/api-gateways answered ${response.status}`);
  return response.json();
}

/** Same shape as ApiGatewayDetails in lambda/dashboard-api/api-gateway-details.ts. */
export interface ApiGatewayDetails {
  id: string;
  name: string;
  type: ApiGateway['type'];
  stages: Array<{ name: string; deploymentId?: string; deployedAt?: string; description?: string }>;
  /** newest first, the latest 25 */
  deployments: Array<{ id: string; description?: string; createdAt?: string; status?: string; stages: string[] }>;
  configuration: Array<{ label: string; value: string }>;
  /** the deployments this project recorded, newest first; absent for APIs it doesn't deploy */
  recorded?: RecordedApiDeployment[];
}

/** Same shape as RecordedApiDeployment in lambda/dashboard-api/api-gateway-deployments.ts. */
export interface RecordedApiDeployment {
  /** what a restore names */
  deployedAt: string;
  deploymentId: string;
  stageName: string;
  lambdaVersion?: string;
  /** s3:// URL of the OpenAPI export a restore re-imports */
  spec: string;
  source: string;
  actor?: string;
  commit?: string;
  description?: string;
  current: boolean;
  verified: boolean;
  rolledBack: boolean;
  stableFor?: string;
}

export async function fetchApiGatewayDetails(api: Pick<ApiGateway, 'id' | 'type'>, signal?: AbortSignal): Promise<ApiGatewayDetails> {
  const url = `/api/api-gateways/${encodeURIComponent(api.id)}?type=${api.type}`;
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.json();
}

/**
 * Restores the API's stage to a recorded deployment. Throws with the API's message when it refuses.
 * Function URLs behind OAC need the body's SHA-256 in x-amz-content-sha256 to sign a POST.
 */
export async function restoreApiDeployment(apiId: string, deployedAt: string, reason?: string): Promise<void> {
  const url = `/api/api-gateways/${encodeURIComponent(apiId)}/restore`;
  const body = JSON.stringify({ deployedAt, ...(reason && { reason }) });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const response = await fetch(url, {
    method: 'POST',
    body,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-amz-content-sha256': Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(''),
    },
  });
  if (!response.ok) {
    const { message } = await response.json().catch(() => ({ message: undefined }));
    throw new Error(message ?? `POST ${url} answered ${response.status}`);
  }
}

// --- Lambda functions --------------------------------------------------------------------------

/** Same shapes as in lambda/dashboard-api/lambda-functions.ts. */
export interface LambdaFunction {
  name: string;
  arn: string;
  runtime: string;
  description?: string;
  aliases: string[];
  lastModified?: string;
}

export interface LambdaFunctionList {
  region: string;
  functions: LambdaFunction[];
}

export interface LambdaFunctionDetails {
  name: string;
  arn: string;
  /** newest first, the latest 25 published versions */
  versions: Array<{ version: string; description?: string; publishedAt?: string; aliases: string[] }>;
  /** additionalVersions: version → weight (0..1) of a weighted alias */
  aliases: Array<{ name: string; version: string; description?: string; additionalVersions?: Record<string, number> }>;
  configuration: Array<{ label: string; value: string }>;
}

export interface LambdaFunctionMetrics {
  from: string;
  to: string;
  invocations: number;
  errors: number;
  throttles: number;
  averageDuration?: number;
  maxDuration?: number;
  maxConcurrency?: number;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.json();
}

export const fetchLambdaFunctions = (signal?: AbortSignal) => getJson<LambdaFunctionList>('/api/lambda-functions', signal);

export const fetchLambdaFunctionDetails = (name: string, signal?: AbortSignal) =>
  getJson<LambdaFunctionDetails>(`/api/lambda-functions/${encodeURIComponent(name)}`, signal);

export const fetchLambdaFunctionMetrics = (name: string, signal?: AbortSignal) =>
  getJson<LambdaFunctionMetrics>(`/api/lambda-functions/${encodeURIComponent(name)}/metrics`, signal);

// --- CloudFront distributions --------------------------------------------------------------------

/** Same shapes as in lambda/dashboard-api/cloudfront-distributions.ts. */
export interface Distribution {
  id: string;
  name: string;
  domain: string;
  aliases: string[];
  status: string;
  enabled: boolean;
  releaseId?: string;
  lastModified?: string;
}

export interface DistributionDetails extends Distribution {
  /** recorded activations, restores and rollbacks, newest first */
  deployments: Array<{
    releaseId: string;
    deployedAt: string;
    source: string;
    actor?: string;
    commit?: string;
    description?: string;
    current: boolean;
    verified: boolean;
    rolledBack: boolean;
    stableFor?: string;
  }>;
  /** false for distributions this project doesn't deploy (no release history) */
  tracked: boolean;
  configuration: Array<{ label: string; value: string }>;
}

export interface DistributionInvalidation { id: string; status: string; createdAt?: string; paths: string[] }

export interface DistributionMetrics {
  from: string;
  to: string;
  requests: number;
  bytesDownloaded: number;
  error4xxRate?: number;
  error5xxRate?: number;
}

const distributionUrl = (id: string, sub = '') => `/api/cloudfront-distributions/${encodeURIComponent(id)}${sub}`;

export const fetchDistributions = (signal?: AbortSignal) =>
  getJson<{ distributions: Distribution[] }>('/api/cloudfront-distributions', signal);

export const fetchDistributionDetails = (id: string, signal?: AbortSignal) => getJson<DistributionDetails>(distributionUrl(id), signal);

export const fetchDistributionInvalidations = (id: string, signal?: AbortSignal) =>
  getJson<{ invalidations: DistributionInvalidation[] }>(distributionUrl(id, '/invalidations'), signal);

export const fetchDistributionMetrics = (id: string, signal?: AbortSignal) =>
  getJson<DistributionMetrics>(distributionUrl(id, '/metrics'), signal);
