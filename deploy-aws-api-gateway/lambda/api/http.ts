// What both backend Lambdas share: JSON responses with CORS, the caller, and the chaos switch.
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export const API_NAME = process.env.API_NAME ?? 'api-user';
/** Share of requests to fail with a 500, set via `-c chaosFailureRate=<0..1>` to demo rollbacks. */
const CHAOS_FAILURE_RATE = Number(process.env.CHAOS_FAILURE_RATE ?? 0);

export const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  // CORS: the frontend calls the API from its CloudFront domain
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

export const callerOf = (event: APIGatewayProxyEvent): string => event.requestContext.authorizer?.claims?.email ?? 'unknown';

/** A 500 for the share of requests chaos mode fails, else undefined. */
export function injectedFailure(): APIGatewayProxyResult | undefined {
  if (Math.random() >= CHAOS_FAILURE_RATE) return undefined;
  // chaos mode on: say so in the backend's log, so a 500 is never mistaken for a real failure
  console.warn(JSON.stringify({ msg: 'injected failure', chaosFailureRate: CHAOS_FAILURE_RATE }));
  return json(500, { message: `Injected failure (CHAOS_FAILURE_RATE=${CHAOS_FAILURE_RATE})` });
}

/** The routes of one resource: GET lists, POST echoes the validated body. */
export function resourceHandler(resource: string) {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const route = `${event.httpMethod} ${event.resource}`;
    const failure = injectedFailure();
    if (failure) return failure;
    const caller = callerOf(event);

    switch (route) {
      case `GET /${resource}`:
        return json(200, { message: `Hello ${caller}, here are the ${resource} from ${API_NAME}`, [resource]: [] });
      case `POST /${resource}`: {
        // Body shape is enforced by the API Gateway request validator.
        const { message } = JSON.parse(event.body ?? '{}') as { message: string };
        return json(201, { message: `Received on ${event.resource}`, echo: message, from: caller });
      }
      default:
        return json(404, { message: `No route for ${route}` });
    }
  };
}
