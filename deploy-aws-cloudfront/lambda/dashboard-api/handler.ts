// The dashboard's read-only API, behind the distributions at /api/* (Lambda function URL with
// Origin Access Control, so only CloudFront can call it).
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { listApiGateways } from './api-gateways.js';

/** The parts of a function URL event this handler reads. */
export interface FunctionUrlEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const rest = new APIGatewayClient({});
const v2 = new ApiGatewayV2Client({});

const json = (statusCode: number, body: unknown): FunctionUrlResult => ({
  statusCode,
  // the data changes with every deployment: never cached, by CloudFront or the browser
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const { method } = event.requestContext.http;
  if (event.rawPath !== '/api/api-gateways') return json(404, { message: 'Not found' });
  if (method !== 'GET' && method !== 'HEAD') return json(405, { message: 'Method not allowed' });
  try {
    return json(200, { region: process.env.AWS_REGION, apis: await listApiGateways(rest, v2) });
  } catch (err) {
    // details stay in the logs; the page only needs to know the list isn't available
    console.error('Listing API Gateways failed', err);
    return json(502, { message: 'Could not list the API Gateways' });
  }
}
