import * as path from 'node:path';

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const BRUNO_DIR = path.join(PROJECT_ROOT, 'bruno');
export const BRUNO_DOTENV = path.join(BRUNO_DIR, '.env');
