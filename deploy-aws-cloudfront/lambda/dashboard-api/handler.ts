// The dashboard's API, behind the distributions at /api/* (Lambda function URL with Origin Access
// Control, so only CloudFront can call it). Read-only but for one action: restoring a recorded
// deployment of an API this project deploys, which the rollback service carries out.
// Every call but GET /api/auth/config needs a signed-in user of the dashboard's user pool (auth.ts).
import { APIGatewayClient, GetRestApiCommand } from '@aws-sdk/client-api-gateway';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getApiGatewayDetails, isApiId } from './api-gateway-details.js';
import { isDeployedAt, listRecordedDeployments, liveLambdaVersions, restoreRecordedDeployment } from './api-gateway-deployments.js';
import { getRecordedSpec } from './api-gateway-specs.js';
import { listApiGateways, type ApiType } from './api-gateways.js';
import { isAliasName, isVersion, pointAlias } from './lambda-aliases.js';
import {
  getDistributionDetails, getDistributionMetrics, isDistributionId, listDistributions, listInvalidations, restoreRelease,
} from './cloudfront-distributions.js';
import {
  getLambdaFunctionDetails, getLambdaFunctionMetrics, isFunctionName, listLambdaFunctions,
} from './lambda-functions.js';
import { getOperation } from './operations.js';
import { listArchivedVersions } from './lambda-archive.js';
import { listRollbacks } from './rollbacks.js';
import { authConfig, authenticate, cognitoVerifier, type User, type VerifyIdToken } from './auth.js';
import { perRegion, regionList, regionOf } from './regions.js';
import { parseRegistered, registrationFor } from './registered-functions.js';

/** The parts of a function URL event this handler reads. */
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  body?: string;
  isBase64Encoded?: boolean;
  /** lower-case names */
  headers?: Record<string, string | undefined>;
  requestContext: { http: { method: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const rest = new APIGatewayClient({});
const lambda = new LambdaClient({});
// the API Gateway and Lambda panels read the region picked at the top of the page (regions.ts)
// ('' is the SDK's default region, i.e. AWS_REGION)
const inRegion = (region: string) => (region ? { region } : {});
const restIn = perRegion((region) => new APIGatewayClient(inRegion(region)));
const v2In = perRegion((region) => new ApiGatewayV2Client(inRegion(region)));
const lambdaIn = perRegion((region) => new LambdaClient(inRegion(region)));
const cloudwatchIn = perRegion((region) => new CloudWatchClient(inRegion(region)));
/** The dashboard's own region: deployment records, rollbacks and the rollback services are here. */
const home = () => process.env.AWS_REGION ?? '';
const cloudfront = new CloudFrontClient({});
// CloudFront metrics only exist in us-east-1
const edgeCloudwatch = new CloudWatchClient({ region: 'us-east-1' });
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const logs = new CloudWatchLogsClient({});
// the functions whose aliases the dashboard may point, from rollback-service/rollback-config.json
const registered = parseRegistered(process.env.REGISTERED_FUNCTIONS);

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
 * GET /api/auth/config: the user pool and client the page signs in with. The only call that needs no
 * signed-in user; every other one answers 401 without a valid ID token in x-auth-token.
 */
export function createHandler(verifier: () => VerifyIdToken) {
  return async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
    const { method } = event.requestContext.http;
    if (event.rawPath === '/api/auth/config') {
      return method === 'GET' || method === 'HEAD' ? json(200, authConfig()) : json(405, { message: 'Method not allowed' });
    }
    const user = await authenticate(event.headers, verifier());
    if (!user) return json(401, { message: 'Sign in required' });
    return route(event, user);
  };
}

let verifier: VerifyIdToken | undefined;
/** The function URL's handler: created once per container, so the pool's signing keys stay cached. */
export const handler = createHandler(() => (verifier ??= cognitoVerifier(authConfig())));

/**
 * The routes, for a signed-in user (`actor` of the restores and alias moves they start: dashboard:<email>).
 *
 * GET /api/regions: the regions the page's region picker offers, and the dashboard's own (the default).
 * The API Gateway and Lambda reads take ?region=<code> (default: the dashboard's own region); the
 * recorded deployments, restores and alias moves only exist there.
 * GET /api/api-gateways: the region's APIs.
 * GET /api/api-gateways/<id>?type=REST|HTTP|WEBSOCKET: one API's stages, deployments and configuration,
 *   and for the APIs this project deploys, their recorded deployments and what each backend's live alias serves now.
 * GET /api/api-gateways/<id>/spec?deployedAt=...: the routes a recorded deployment serves (its OpenAPI export).
 * POST /api/api-gateways/<id>/restore {"deployedAt": "...", "reason"?: "..."}: restores a recorded deployment.
 * POST /api/cloudfront-distributions/<id>/restore {"deployedAt": "...", "reason"?: "..."}: restores a recorded release.
 * POST /api/lambda-functions/<name>/point-alias {"aliasName": "...", "version": 3}: points an alias of a
 *   registered function at a version.
 * The writes answer 202 with an operation id: the rollback service runs them, and
 * GET /api/operations/<id> follows the run (status, steps, progress, its log lines).
 * GET /api/lambda-functions: the region's functions registered for rollback (rollback-config.json).
 * GET /api/lambda-functions/<name>: one function's versions (with their archive and stable marks), aliases and configuration.
 * GET /api/lambda-functions/<name>/metrics: its last 24 hours of metrics.
 * GET /api/cloudfront-distributions: the account's distributions.
 * GET /api/cloudfront-distributions/<id>: one distribution's release history and configuration.
 * GET /api/cloudfront-distributions/<id>/invalidations: its latest invalidations.
 * GET /api/cloudfront-distributions/<id>/metrics: its last 24 hours of metrics.
 * GET /api/rollbacks: every rollback of the APIs, Lambda functions and sites, dev and prod, newest first.
 */
export async function route(event: FunctionUrlEvent, user?: User): Promise<FunctionUrlResult> {
  const { method } = event.requestContext.http;
  const actor = user ? `dashboard:${user.email}` : 'dashboard';
  if (event.rawPath.startsWith('/api/operations/')) return await operation(event, method);
  if (event.rawPath === '/api/rollbacks') return await rollbacks(method);
  if (event.rawPath === '/api/regions') {
    return method === 'GET' || method === 'HEAD' ? json(200, regionList(home())) : json(405, { message: 'Method not allowed' });
  }
  const route = /^\/api\/(api-gateways|lambda-functions|cloudfront-distributions)(?:\/([^/]+)(?:\/(metrics|invalidations|restore|point-alias|spec))?)?$/.exec(event.rawPath);
  if (!route) return json(404, { message: 'Not found' });
  const [, resource, id, sub] = route;
  const restore = sub === 'restore' && (resource === 'api-gateways' || resource === 'cloudfront-distributions');
  const point = sub === 'point-alias' && resource === 'lambda-functions';
  const write = restore || point;
  if (write ? method !== 'POST' : method !== 'GET' && method !== 'HEAD') return json(405, { message: 'Method not allowed' });
  try {
    if (restore && resource === 'api-gateways') return await restoreApiDeployment(id!, event, actor);
    if (restore) return await restoreDistributionRelease(id!, event, actor);
    if (point) return await pointLambdaAlias(id!, event, actor);
    if (resource === 'api-gateways') return await apiGateways(id, sub, new URLSearchParams(event.rawQueryString ?? ''));
    if (resource === 'lambda-functions') return await lambdaFunctions(id, sub, new URLSearchParams(event.rawQueryString ?? ''));
    return await distributions(id, sub);
  } catch (err) {
    // details stay in the logs; the page only needs to know the data isn't available
    console.error(`${write ? 'Changing' : 'Reading'} ${event.rawPath} failed`, err);
    if (point) return json(502, { message: 'Could not point the alias' });
    return json(502, { message: restore ? `Could not restore the ${resource === 'api-gateways' ? 'deployment' : 'release'}` : `Could not read the ${RESOURCE_NAMES[resource]}` });
  }
}

/** Read-only: the rollbacks recorded in the deployments tables and the Lambda version archives. */
async function rollbacks(method: string) {
  if (method !== 'GET' && method !== 'HEAD') return json(405, { message: 'Method not allowed' });
  try {
    return json(200, { rollbacks: await listRollbacks(dynamo, process.env.PROJECT_NAME!, registered) });
  } catch (err) {
    console.error('Reading the rollbacks failed', err);
    return json(502, { message: 'Could not read the rollbacks' });
  }
}

async function apiGateways(id: string | undefined, sub: string | undefined, query: URLSearchParams) {
  const region = regionOf(query, home());
  if (region === undefined) return json(400, { message: 'Unknown ?region (GET /api/regions lists them)' });
  if (sub === 'spec') return apiSpec(id!, query.get('deployedAt'), region);
  if (sub) return json(404, { message: 'Not found' });
  if (!id) return json(200, { region, apis: await listApiGateways(restIn(region), v2In(region)) });
  const type = query.get('type') as ApiType;
  if (!isApiId(id) || !API_TYPES.includes(type)) return json(400, { message: 'Expected an API id and ?type=REST|HTTP|WEBSOCKET' });
  const details = await getApiGatewayDetails(restIn(region), v2In(region), id, type, region);
  if (!details) return json(404, { message: `No ${type} API ${id}` });
  // the deployments this project records (and can restore) are of APIs in its own region only
  const recorded = type === 'REST' && region === home()
    ? await listRecordedDeployments(dynamo, process.env.PROJECT_NAME!, details.name, id) : undefined;
  if (!recorded) return json(200, details);
  return json(200, { ...details, recorded, liveLambdaVersions: await liveLambdaVersions(lambda, recorded) });
}

/** The routes a recorded deployment of a REST API serves, from its OpenAPI export in S3. */
async function apiSpec(id: string, deployedAt: string | null, region: string) {
  if (!isApiId(id) || !isDeployedAt(deployedAt)) return json(400, { message: 'Expected a REST API id and ?deployedAt=<ISO 8601>' });
  let name: string;
  try {
    name = (await restIn(region).send(new GetRestApiCommand({ restApiId: id }))).name ?? id;
  } catch (err) {
    if ((err as Error).name === 'NotFoundException') return json(404, { message: `No REST API ${id}` });
    throw err;
  }
  const outcome = await getRecordedSpec(dynamo, s3, process.env.PROJECT_NAME!, { id, name }, deployedAt);
  return outcome.ok ? json(200, outcome.spec) : json(outcome.status, { message: outcome.message });
}

/** GET /api/operations/<id>: how a restore or alias move the page started is going. */
async function operation(event: FunctionUrlEvent, method: string) {
  if (method !== 'GET' && method !== 'HEAD') return json(405, { message: 'Method not allowed' });
  const id = event.rawPath.slice('/api/operations/'.length);
  try {
    const view = await getOperation(logs, process.env.PROJECT_NAME!, id);
    return view ? json(200, view) : json(404, { message: `No operation ${id}` });
  } catch (err) {
    console.error(`Reading operation ${id} failed`, err);
    return json(502, { message: 'Could not read the rollback service\'s log' });
  }
}

const RESTORE_BODY ='{"deployedAt": "<ISO 8601>", "reason"?: "<up to 200 characters>"}';

/** A restore's body: which record (its deployedAt), and an optional reason. Undefined if malformed. */
function restoreBody(event: FunctionUrlEvent): { deployedAt: string; reason?: string } | undefined {
  let body: { deployedAt?: unknown; reason?: unknown } | undefined;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '');
  } catch {
    return undefined;
  }
  const reason = body?.reason;
  if (!isDeployedAt(body?.deployedAt) || (reason !== undefined && (typeof reason !== 'string' || reason.length > 200))) return undefined;
  return { deployedAt: body!.deployedAt as string, ...(reason !== undefined && { reason: reason as string }) };
}

async function restoreApiDeployment(id: string, event: FunctionUrlEvent, actor: string) {
  const body = restoreBody(event);
  if (!isApiId(id) || !body) return json(400, { message: `Expected a REST API id and ${RESTORE_BODY}` });
  let name: string;
  try {
    name = (await rest.send(new GetRestApiCommand({ restApiId: id }))).name ?? id;
  } catch (err) {
    if ((err as Error).name === 'NotFoundException') return json(404, { message: `No REST API ${id}` });
    throw err;
  }
  const outcome = await restoreRecordedDeployment(dynamo, lambda, process.env.PROJECT_NAME!, { id, name }, { ...body, actor });
  return outcome.ok ? json(202, { operationId: outcome.operationId }) : json(outcome.status, { message: outcome.message });
}

async function restoreDistributionRelease(id: string, event: FunctionUrlEvent, actor: string) {
  const body = restoreBody(event);
  if (!isDistributionId(id) || !body) return json(400, { message: `Expected a distribution id and ${RESTORE_BODY}` });
  const outcome = await restoreRelease(cloudfront, dynamo, lambda, process.env.PROJECT_NAME!, id, { ...body, actor });
  return outcome.ok ? json(202, { operationId: outcome.operationId }) : json(outcome.status, { message: outcome.message });
}

// Only the functions registered for rollback (rollback-config.json): listed, read and changed.
async function lambdaFunctions(name: string | undefined, sub: string | undefined, query: URLSearchParams) {
  const region = regionOf(query, home());
  if (region === undefined) return json(400, { message: 'Unknown ?region (GET /api/regions lists them)' });
  const project = process.env.PROJECT_NAME!;
  const isRegistered = (fn: string) => registrationFor(fn, registered, project) !== undefined;
  if (!name) return json(200, { region, functions: await listLambdaFunctions(lambdaIn(region), isRegistered) });
  if (!isFunctionName(name)) return json(400, { message: 'Expected a function name' });
  if (sub && sub !== 'metrics') return json(404, { message: 'Not found' });
  const registration = registrationFor(name, registered, project);
  if (!registration) return json(404, { message: `${name} isn't registered for rollback (rollback-config.json)` });
  if (sub === 'metrics') return json(200, await getLambdaFunctionMetrics(cloudwatchIn(region), name));
  const [details, archive] = await Promise.all([
    getLambdaFunctionDetails(lambdaIn(region), name),
    listArchivedVersions(dynamo, registration.archiveTable, name),
  ]);
  if (!details) return json(404, { message: `No function ${name}` });
  const versions = details.versions.map((v) => (archive.has(v.version) ? { ...v, archive: archive.get(v.version) } : v));
  return json(200, { ...details, versions, managedAlias: registration.alias });
}

async function pointLambdaAlias(name: string, event: FunctionUrlEvent, actor: string) {
  let body: { aliasName?: unknown; version?: unknown } | undefined;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '');
  } catch { /* answered below */ }
  if (!isFunctionName(name) || !isAliasName(body?.aliasName) || !isVersion(body?.version)) {
    return json(400, { message: 'Expected a function name and {"aliasName": "<alias>", "version": <published version number>}' });
  }
  const outcome = await pointAlias(lambda, registered, process.env.PROJECT_NAME!, name, {
    aliasName: body!.aliasName as string, version: body!.version as number, actor,
  });
  return outcome.ok ? json(202, { operationId: outcome.operationId }) : json(outcome.status, { message: outcome.message });
}

async function distributions(id: string | undefined, sub: string | undefined) {
  if (!id) return json(200, { distributions: await listDistributions(cloudfront) });
  if (!isDistributionId(id)) return json(400, { message: 'Expected a distribution id' });
  if (sub === 'metrics') return json(200, await getDistributionMetrics(edgeCloudwatch, id));
  if (sub === 'invalidations') return json(200, { invalidations: await listInvalidations(cloudfront, id) });
  const details = await getDistributionDetails(cloudfront, dynamo, id, process.env.PROJECT_NAME!);
  return details ? json(200, details) : json(404, { message: `No distribution ${id}` });
}
