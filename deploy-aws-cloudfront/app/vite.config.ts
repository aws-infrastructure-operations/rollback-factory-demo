import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = import.meta.dirname;
// The dashboard API lives behind the distribution at /api/*. For `npm run app:dev`, set
// DASHBOARD_API_URL to a deployed site (e.g. https://dxxxx.cloudfront.net) to proxy /api there.
const apiUrl = process.env.DASHBOARD_API_URL;

// Settings come from VITE_ENV, VITE_RELEASE_ID and VITE_BUILT_AT (see src/config.ts).
export default defineConfig({
  root,
  plugins: [react()],
  server: apiUrl ? { proxy: { '/api': { target: apiUrl, changeOrigin: true } } } : undefined,
  build: {
    outDir: resolve(root, '..', 'dist'),
    emptyOutDir: true,
  },
});
