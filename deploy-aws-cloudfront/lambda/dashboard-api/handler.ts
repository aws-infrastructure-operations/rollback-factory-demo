// The dashboard's API, behind the distributions at /api/* (Lambda function URL with Origin Access
// Control, so only CloudFront can call it). Read-only but for one action: restoring a recorded
// deployment of an API this project deploys, which the rollback service carries out.
import { APIGatewayClient, GetRestApiCommand } from '@aws-sdk/client-api-gateway';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getApiGatewayDetails, isApiId } from './api-gateway-details.js';
import { isDeployedAt, listRecordedDeployments, restoreRecordedDeployment } from './api-gateway-deployments.js';
import { listApiGateways, type ApiType } from './api-gateways.js';
import {
  getDistributionDetails, getDistributionMetrics, isDistributionId, listDistributions, listInvalidations,
} from './cloudfront-distributions.js';
import {
  getLambdaFunctionDetails, getLambdaFunctionMetrics, isFunctionName, listLambdaFunctions,
} from './lambda-functions.js';

/** The parts of a function URL event this handler reads. */
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  body?: string;
  isBase64Encoded?: boolean;
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
const cloudfront = new CloudFrontClient({});
// CloudFront metrics only exist in us-east-1
const edgeCloudwatch = new CloudWatchClient({ region: 'us-east-1' });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const json = (statusCode: number, body: unknown): FunctionUrlResult => ({
  statusCode,
  // the data changes with every deployment: never cached, by CloudFront or the browser
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

const API_TYPES: ApiType[] = ['REST', 'HTTP', 'WEBSOCKET'];
const RESOURCE_NAMES: Record<string, string> = {
  'api-gateways': 'API Gateways', 'lambda-functions': 'Lambda functions', 'cloudfront-distributions': 'CloudFront distributions',
};

/**
 * GET /api/api-gateways: the region's APIs.
 * GET /api/api-gateways/<id>?type=REST|HTTP|WEBSOCKET: one API's stages, deployments and configuration,
 *   and for the APIs this project deploys, their recorded deployments.
 * POST /api/api-gateways/<id>/restore {"deployedAt": "...", "reason"?: "..."}: restores a recorded deployment.
 * GET /api/lambda-functions: the region's functions.
 * GET /api/lambda-functions/<name>: one function's versions, aliases and configuration.
 * GET /api/lambda-functions/<name>/metrics: its last 24 hours of metrics.
 * GET /api/cloudfront-distributions: the account's distributions.
 * GET /api/cloudfront-distributions/<id>: one distribution's release history and configuration.
 * GET /api/cloudfront-distributions/<id>/invalidations: its latest invalidations.
 * GET /api/cloudfront-distributions/<id>/metrics: its last 24 hours of metrics.
 */
export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const { method } = event.requestContext.http;
  const route = /^\/api\/(api-gateways|lambda-functions|cloudfront-distributions)(?:\/([^/]+)(?:\/(metrics|invalidations|restore))?)?$/.exec(event.rawPath);
  if (!route) return json(404, { message: 'Not found' });
  const [, resource, id, sub] = route;
  const restore = resource === 'api-gateways' && sub === 'restore';
  if (restore ? method !== 'POST' : method !== 'GET' && method !== 'HEAD') return json(405, { message: 'Method not allowed' });
  try {
    if (restore) return await restoreApiDeployment(id!, event);
    if (resource === 'api-gateways') return await apiGateways(id, sub, new URLSearchParams(event.rawQueryString ?? ''));
    if (resource === 'lambda-functions') return await lambdaFunctions(id, sub);
    return await distributions(id, sub);
  } catch (err) {
    // details stay in the logs; the page only needs to know the data isn't available
    console.error(`${restore ? 'Restoring' : 'Reading'} ${event.rawPath} failed`, err);
    return json(502, { message: restore ? 'Could not restore the deployment' : `Could not read the ${RESOURCE_NAMES[resource]}` });
  }
}

async function apiGateways(id: string | undefined, sub: string | undefined, query: URLSearchParams) {
  const region = process.env.AWS_REGION!;
  if (sub) return json(404, { message: 'Not found' });
  if (!id) return json(200, { region, apis: await listApiGateways(rest, v2) });
  const type = query.get('type') as ApiType;
  if (!isApiId(id) || !API_TYPES.includes(type)) return json(400, { message: 'Expected an API id and ?type=REST|HTTP|WEBSOCKET' });
  const details = await getApiGatewayDetails(rest, v2, id, type, region);
  if (!details) return json(404, { message: `No ${type} API ${id}` });
  const recorded = type === 'REST' ? await listRecordedDeployments(dynamo, process.env.PROJECT_NAME!, details.name, id) : undefined;
  return json(200, recorded ? { ...details, recorded } : details);
}

async function restoreApiDeployment(id: string, event: FunctionUrlEvent) {
  let body: { deployedAt?: unknown; reason?: unknown } | undefined;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '');
  } catch { /* answered below */ }
  const reason = body?.reason;
  if (!isApiId(id) || !isDeployedAt(body?.deployedAt) || (reason !== undefined && (typeof reason !== 'string' || reason.length > 200))) {
    return json(400, { message: 'Expected a REST API id and {"deployedAt": "<ISO 8601>", "reason"?: "<up to 200 characters>"}' });
  }
  let name: string;
  try {
    name = (await rest.send(new GetRestApiCommand({ restApiId: id }))).name ?? id;
  } catch (err) {
    if ((err as Error).name === 'NotFoundException') return json(404, { message: `No REST API ${id}` });
    throw err;
  }
  const outcome = await restoreRecordedDeployment(dynamo, lambda, process.env.PROJECT_NAME!, { id, name }, {
    deployedAt: body!.deployedAt as string, reason: reason as string | undefined,
  });
  return outcome.ok ? json(200, outcome.result) : json(outcome.status, { message: outcome.message });
}

async function lambdaFunctions(name: string | undefined, sub: string | undefined) {
  if (!name) return json(200, { region: process.env.AWS_REGION!, functions: await listLambdaFunctions(lambda) });
  if (!isFunctionName(name)) return json(400, { message: 'Expected a function name' });
  if (sub && sub !== 'metrics') return json(404, { message: 'Not found' });
  if (sub === 'metrics') return json(200, await getLambdaFunctionMetrics(cloudwatch, name));
  const details = await getLambdaFunctionDetails(lambda, name);
  return details ? json(200, details) : json(404, { message: `No function ${name}` });
}

async function distributions(id: string | undefined, sub: string | undefined) {
  if (!id) return json(200, { distributions: await listDistributions(cloudfront) });
  if (!isDistributionId(id)) return json(400, { message: 'Expected a distribution id' });
  if (sub === 'restore') return json(404, { message: 'Not found' });
  if (sub === 'metrics') return json(200, await getDistributionMetrics(edgeCloudwatch, id));
  if (sub === 'invalidations') return json(200, { invalidations: await listInvalidations(cloudfront, id) });
  const details = await getDistributionDetails(cloudfront, dynamo, id, process.env.PROJECT_NAME!);
  return details ? json(200, details) : json(404, { message: `No distribution ${id}` });
}
