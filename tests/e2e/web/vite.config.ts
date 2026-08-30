import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const harnessRoot = fileURLToPath(new URL('./harness', import.meta.url));

export default defineConfig({
  root: harnessRoot,
  publicDir: false,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4177,
    strictPort: true,
  },
});
