// The /orders backend (rollback-factory-demo-api-orders-<env>), registered for rollback on its own.
// Mocked like the others: GET lists nothing, POST echoes the message.
import { resourceHandler } from './http.js';

export const handler = resourceHandler('orders');
