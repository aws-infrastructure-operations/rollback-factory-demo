import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

const root = import.meta.dirname;
/** Without these the release can't sign in or reach the API, so a build fails fast instead. */
const REQUIRED = ['VITE_API_URL', 'VITE_USER_POOL_ID', 'VITE_USER_POOL_CLIENT_ID', 'VITE_REGION'];

export default defineConfig(({ command, mode }) => {
  if (command === 'build') {
    // loadEnv also picks up VITE_* variables from the environment (how the release build passes them)
    const env = loadEnv(mode, root);
    const missing = REQUIRED.filter((name) => !env[name]);
    if (missing.length) throw new Error(`Missing build settings: ${missing.join(', ')}`);
  }
  return {
    root,
    build: {
      outDir: resolve(root, '..', 'dist'),
      emptyOutDir: true,
      // Two real pages, no SPA fallback (see FE-02).
      rolldownOptions: {
        input: { index: resolve(root, 'index.html'), app: resolve(root, 'app.html') },
      },
    },
  };
});
