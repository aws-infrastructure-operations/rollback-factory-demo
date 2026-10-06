import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

// Settings come from VITE_ENV, VITE_RELEASE_ID and VITE_BUILT_AT (see src/config.ts).
export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: resolve(root, '..', 'dist'),
    emptyOutDir: true,
  },
});
