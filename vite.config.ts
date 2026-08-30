import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const clientRoot = fileURLToPath(new URL('./src/web/client', import.meta.url));
const webOutDir = fileURLToPath(new URL('./dist/web', import.meta.url));

export default defineConfig({
  root: clientRoot,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
  },
  build: {
    emptyOutDir: false,
    outDir: webOutDir,
    sourcemap: true,
  },
});
