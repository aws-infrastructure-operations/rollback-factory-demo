// The /users backend (rollback-factory-demo-api-users-<env>), registered for rollback on its own.
import { resourceHandler } from './http.js';

export const handler = resourceHandler('users');
