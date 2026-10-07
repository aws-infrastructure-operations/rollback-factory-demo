// The /messages backend (rollback-factory-demo-api-messages-<env>), registered for rollback on its own.
import { resourceHandler } from './http.js';

export const handler = resourceHandler('messages');
