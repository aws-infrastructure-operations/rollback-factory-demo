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
