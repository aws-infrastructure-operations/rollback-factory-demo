// One API for the dashboard's detail panel: its stages (and the deployment each serves), its
// deployments, newest first, and a few configuration settings. Read-only.
import {
  APIGatewayClient, GetDeploymentsCommand, GetRestApiCommand, GetStagesCommand,
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client, GetApiCommand, GetDeploymentsCommand as GetV2DeploymentsCommand,
  GetStagesCommand as GetV2StagesCommand,
} from '@aws-sdk/client-apigatewayv2';
import type { RecordedApiDeployment } from './api-gateway-deployments.js';
import type { ApiType } from './api-gateways.js';

/** What GET /api/api-gateways/<id>?type=<type> returns (app/src/api.ts has the same shape). */
export interface ApiGatewayDetails {
  id: string;
  name: string;
  type: ApiType;
  stages: Array<{ name: string; deploymentId?: string; deployedAt?: string; description?: string }>;
  /** newest first, at most MAX_DEPLOYMENTS */
  deployments: Array<{ id: string; description?: string; createdAt?: string; status?: string; stages: string[] }>;
  configuration: Array<{ label: string; value: string }>;
  /** the deployments this project recorded (DynamoDB), newest first; absent for APIs it doesn't deploy */
  recorded?: RecordedApiDeployment[];
  /** with recorded: each backend Lambda's live version now (function name -> version), what a restore runs */
  liveLambdaVersions?: Record<string, string>;
}

export const MAX_DEPLOYMENTS = 25;

/** API Gateway ids are 10 lowercase letters or digits, for REST and v2 alike. */
export const isApiId = (id: string) => /^[a-z0-9]{10}$/.test(id);

const iso = (date?: Date) => date?.toISOString();
const newestFirst = (a: { createdAt?: string }, b: { createdAt?: string }) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '');

/** Undefined when the API doesn't exist (NotFoundException). */
export async function getApiGatewayDetails(
  rest: APIGatewayClient,
  v2: ApiGatewayV2Client,
  id: string,
  type: ApiType,
  region: string,
): Promise<ApiGatewayDetails | undefined> {
  try {
    return type === 'REST' ? await restDetails(rest, id, region) : await v2Details(v2, id);
  } catch (err) {
    if ((err as Error).name === 'NotFoundException') return undefined;
    throw err;
  }
}

async function restDetails(client: APIGatewayClient, restApiId: string, region: string): Promise<ApiGatewayDetails> {
  const [api, { item: stageItems = [] }, deploymentItems] = await Promise.all([
    client.send(new GetRestApiCommand({ restApiId })),
    client.send(new GetStagesCommand({ restApiId })),
    restDeployments(client, restApiId),
  ]);
  const stages = stageItems.map((s) => ({
    name: s.stageName!,
    deploymentId: s.deploymentId,
    deployedAt: iso(s.lastUpdatedDate ?? s.createdDate),
    description: s.description,
  }));
  return {
    id: restApiId,
    name: api.name ?? restApiId,
    type: 'REST',
    stages: stages.sort((a, b) => a.name.localeCompare(b.name)),
    deployments: withStages(deploymentItems.map((d) => ({ id: d.id!, description: d.description, createdAt: iso(d.createdDate) })), stages),
    configuration: compact([
      ['Description', api.description],
      ['Endpoint type', api.endpointConfiguration?.types?.join(', ')],
      ['Invoke URL', `https://${restApiId}.execute-api.${region}.amazonaws.com/<stage>`],
      ['Default endpoint', api.disableExecuteApiEndpoint ? 'disabled' : 'enabled'],
      ['API key source', api.apiKeySource],
      ['Version', api.version],
      ['Created', iso(api.createdDate)],
    ]),
  };
}

async function restDeployments(client: APIGatewayClient, restApiId: string) {
  const items = [];
  let position: string | undefined;
  do {
    const page = await client.send(new GetDeploymentsCommand({ restApiId, limit: 500, position }));
    items.push(...(page.items ?? []));
    position = page.position;
  } while (position);
  return items;
}

async function v2Details(client: ApiGatewayV2Client, apiId: string): Promise<ApiGatewayDetails> {
  const [api, stageItems, deploymentItems] = await Promise.all([
    client.send(new GetApiCommand({ ApiId: apiId })),
    v2Pages((NextToken) => client.send(new GetV2StagesCommand({ ApiId: apiId, NextToken }))),
    v2Pages((NextToken) => client.send(new GetV2DeploymentsCommand({ ApiId: apiId, NextToken }))),
  ]);
  const stages = stageItems.map((s) => ({
    name: s.StageName!,
    deploymentId: s.DeploymentId,
    deployedAt: iso(s.LastUpdatedDate ?? s.CreatedDate),
    description: s.Description,
  }));
  return {
    id: apiId,
    name: api.Name ?? apiId,
    type: api.ProtocolType === 'WEBSOCKET' ? 'WEBSOCKET' : 'HTTP',
    stages: stages.sort((a, b) => a.name.localeCompare(b.name)),
    deployments: withStages(deploymentItems.map((d) => ({
      id: d.DeploymentId!,
      description: d.Description,
      createdAt: iso(d.CreatedDate),
      status: d.DeploymentStatus,
    })), stages),
    configuration: compact([
      ['Description', api.Description],
      ['Protocol', api.ProtocolType],
      ['Invoke URL', api.ApiEndpoint],
      ['Default endpoint', api.DisableExecuteApiEndpoint ? 'disabled' : 'enabled'],
      ['Route selection', api.RouteSelectionExpression],
      ['CORS origins', api.CorsConfiguration?.AllowOrigins?.join(', ')],
      ['Version', api.Version],
      ['Created', iso(api.CreatedDate)],
    ]),
  };
}

async function v2Pages<T>(page: (nextToken?: string) => Promise<{ Items?: T[]; NextToken?: string }>) {
  const items: T[] = [];
  let nextToken: string | undefined;
  do {
    const result = await page(nextToken);
    items.push(...(result.Items ?? []));
    nextToken = result.NextToken;
  } while (nextToken);
  return items;
}

/** Newest first, capped, each with the stages that serve it. */
function withStages(
  deployments: Array<{ id: string; description?: string; createdAt?: string; status?: string }>,
  stages: Array<{ name: string; deploymentId?: string }>,
) {
  return deployments.sort(newestFirst).slice(0, MAX_DEPLOYMENTS).map((d) => ({
    ...d,
    stages: stages.filter((s) => s.deploymentId === d.id).map((s) => s.name),
  }));
}

const compact = (rows: Array<[string, string | undefined]>) =>
  rows.filter(([, value]) => value).map(([label, value]) => ({ label, value: value! }));
