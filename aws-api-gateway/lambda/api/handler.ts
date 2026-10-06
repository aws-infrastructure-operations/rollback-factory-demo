import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const API_NAME = process.env.API_NAME ?? 'api-user';
/** Share of requests to fail with a 500, set via `-c chaosFailureRate=<0..1>` to demo rollbacks. */
const CHAOS_FAILURE_RATE = Number(process.env.CHAOS_FAILURE_RATE ?? 0);

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const caller = event.requestContext.authorizer?.claims?.email ?? 'unknown';
  const route = `${event.httpMethod} ${event.resource}`;

  if (Math.random() < CHAOS_FAILURE_RATE) {
    return json(500, { message: `Injected failure (CHAOS_FAILURE_RATE=${CHAOS_FAILURE_RATE})` });
  }

  switch (route) {
    case 'GET /users':
      return json(200, { message: `Hello ${caller}, here are the users from ${API_NAME}`, users: [] });
    case 'GET /messages':
      return json(200, { message: `Hello ${caller}, here are the messages from ${API_NAME}`, messages: [] });
    case 'POST /users':
    case 'POST /messages': {
      // Body shape is enforced by the API Gateway request validator.
      const { message } = JSON.parse(event.body ?? '{}') as { message: string };
      return json(201, { message: `Received on ${event.resource}`, echo: message, from: caller });
    }
    default:
      return json(404, { message: `No route for ${route}` });
  }
};
