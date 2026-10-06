// The dashboard's read-only API, behind the distributions at /api/* (Lambda function URL with
// Origin Access Control, so only CloudFront can call it).
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { getApiGatewayDetails, isApiId } from './api-gateway-details.js';
import { listApiGateways, type ApiType } from './api-gateways.js';
import {
  getLambdaFunctionDetails, getLambdaFunctionMetrics, isFunctionName, listLambdaFunctions,
} from './lambda-functions.js';

/** The parts of a function URL event this handler reads. */
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  requestContext: { http: { method: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const rest = new APIGatewayClient({});
const v2 = new ApiGatewayV2Client({});
const lambda = new LambdaClient({});
const cloudwatch = new CloudWatchClient({});

const json = (statusCode: number, body: unknown): FunctionUrlResult => ({
  statusCode,
  // the data changes with every deployment: never cached, by CloudFront or the browser
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

const API_TYPES: ApiType[] = ['REST', 'HTTP', 'WEBSOCKET'];

/**
 * GET /api/api-gateways: the region's APIs.
 * GET /api/api-gateways/<id>?type=REST|HTTP|WEBSOCKET: one API's stages, deployments and configuration.
 * GET /api/lambda-functions: the region's functions.
 * GET /api/lambda-functions/<name>: one function's versions, aliases and configuration.
 * GET /api/lambda-functions/<name>/metrics: its last 24 hours of metrics.
 */
export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const { method } = event.requestContext.http;
  const route = /^\/api\/(api-gateways|lambda-functions)(?:\/([^/]+)(?:\/(metrics))?)?$/.exec(event.rawPath);
  if (!route) return json(404, { message: 'Not found' });
  if (method !== 'GET' && method !== 'HEAD') return json(405, { message: 'Method not allowed' });
  const [, resource, id, sub] = route;
  try {
    return resource === 'api-gateways'
      ? await apiGateways(id, sub, new URLSearchParams(event.rawQueryString ?? ''))
      : await lambdaFunctions(id, sub);
  } catch (err) {
    // details stay in the logs; the page only needs to know the data isn't available
    console.error(`Reading ${event.rawPath} failed`, err);
    return json(502, { message: `Could not read the ${resource === 'api-gateways' ? 'API Gateways' : 'Lambda functions'}` });
  }
}

async function apiGateways(id: string | undefined, sub: string | undefined, query: URLSearchParams) {
  const region = process.env.AWS_REGION!;
  if (sub) return json(404, { message: 'Not found' });
  if (!id) return json(200, { region, apis: await listApiGateways(rest, v2) });
  const type = query.get('type') as ApiType;
  if (!isApiId(id) || !API_TYPES.includes(type)) return json(400, { message: 'Expected an API id and ?type=REST|HTTP|WEBSOCKET' });
  const details = await getApiGatewayDetails(rest, v2, id, type, region);
  return details ? json(200, details) : json(404, { message: `No ${type} API ${id}` });
}

async function lambdaFunctions(name: string | undefined, sub: string | undefined) {
  if (!name) return json(200, { region: process.env.AWS_REGION!, functions: await listLambdaFunctions(lambda) });
  if (!isFunctionName(name)) return json(400, { message: 'Expected a function name' });
  if (sub === 'metrics') return json(200, await getLambdaFunctionMetrics(cloudwatch, name));
  const details = await getLambdaFunctionDetails(lambda, name);
  return details ? json(200, details) : json(404, { message: `No function ${name}` });
}
