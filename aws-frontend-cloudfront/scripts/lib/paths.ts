import * as path from 'node:path';

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
/** Vite's output (see app/vite.config.ts). */
export const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
/** Written by release:build, read by release:upload. */
export const RELEASE_FILE = path.join(PROJECT_ROOT, 'release.json');
