// Lists the API Gateway APIs of the Lambda's region for the dashboard: REST APIs (API Gateway v1)
// and HTTP/WebSocket APIs (v2), each with its stage names and when a stage last changed.
import { APIGatewayClient, GetRestApisCommand, GetStagesCommand } from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client, GetApisCommand, GetStagesCommand as GetV2StagesCommand,
} from '@aws-sdk/client-apigatewayv2';
import { mapLimit } from './util.js';

export type ApiType = 'REST' | 'HTTP' | 'WEBSOCKET';

/** What GET /api/api-gateways returns per API (app/src/api.ts has the same shape). */
export interface ApiGatewaySummary {
  id: string;
  name: string;
  type: ApiType;
  stages: string[];
  /** ISO 8601: the latest stage update (a deployment updates its stage), absent without stages. */
  lastDeployed?: string;
}

interface Stage { name: string; updatedAt?: Date }

/** At most this many GetStages calls at a time: the API Gateway control plane throttles early. */
const STAGE_CONCURRENCY = 4;

export async function listApiGateways(
  rest: APIGatewayClient,
  v2: ApiGatewayV2Client,
): Promise<ApiGatewaySummary[]> {
  const [restApis, v2Apis] = await Promise.all([listRestApis(rest), listV2Apis(v2)]);
  const apis = [
    ...restApis.map((api) => ({ ...api, stages: () => restStages(rest, api.id) })),
    ...v2Apis.map((api) => ({ ...api, stages: () => v2Stages(v2, api.id) })),
  ];
  const summaries = await mapLimit(apis, STAGE_CONCURRENCY, async ({ stages, ...api }) => summarize(api, await stages()));
  // most recently deployed first, APIs without stages last
  return summaries.sort((a, b) => (b.lastDeployed ?? '').localeCompare(a.lastDeployed ?? '') || a.name.localeCompare(b.name));
}

function summarize(api: { id: string; name: string; type: ApiType }, stages: Stage[]): ApiGatewaySummary {
  const updated = stages.map((s) => s.updatedAt?.getTime() ?? 0).filter(Boolean);
  return {
    ...api,
    stages: stages.map((s) => s.name).sort(),
    ...(updated.length && { lastDeployed: new Date(Math.max(...updated)).toISOString() }),
  };
}

async function listRestApis(client: APIGatewayClient) {
  const apis: Array<{ id: string; name: string; type: ApiType }> = [];
  let position: string | undefined;
  do {
    const page = await client.send(new GetRestApisCommand({ limit: 500, position }));
    for (const api of page.items ?? []) apis.push({ id: api.id!, name: api.name ?? api.id!, type: 'REST' });
    position = page.position;
  } while (position);
  return apis;
}

async function listV2Apis(client: ApiGatewayV2Client) {
  const apis: Array<{ id: string; name: string; type: ApiType }> = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new GetApisCommand({ MaxResults: '500', NextToken: nextToken }));
    for (const api of page.Items ?? []) {
      apis.push({ id: api.ApiId!, name: api.Name ?? api.ApiId!, type: api.ProtocolType === 'WEBSOCKET' ? 'WEBSOCKET' : 'HTTP' });
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return apis;
}

async function restStages(client: APIGatewayClient, restApiId: string): Promise<Stage[]> {
  const { item = [] } = await client.send(new GetStagesCommand({ restApiId }));
  return item.map((s) => ({ name: s.stageName!, updatedAt: s.lastUpdatedDate ?? s.createdDate }));
}

async function v2Stages(client: ApiGatewayV2Client, apiId: string): Promise<Stage[]> {
  const stages: Stage[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new GetV2StagesCommand({ ApiId: apiId, NextToken: nextToken }));
    for (const s of page.Items ?? []) stages.push({ name: s.StageName!, updatedAt: s.LastUpdatedDate ?? s.CreatedDate });
    nextToken = page.NextToken;
  } while (nextToken);
  return stages;
}
