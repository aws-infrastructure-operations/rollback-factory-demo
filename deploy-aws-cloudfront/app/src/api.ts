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
}

export async function fetchApiGatewayDetails(api: Pick<ApiGateway, 'id' | 'type'>, signal?: AbortSignal): Promise<ApiGatewayDetails> {
  const url = `/api/api-gateways/${encodeURIComponent(api.id)}?type=${api.type}`;
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.json();
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
