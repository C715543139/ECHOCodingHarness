import { defineConfig } from 'tsup';

export default defineConfig({
  // Vite writes dist/web after tsup. Node rebuilds must not wipe those assets.
  clean: false,
  dts: true,
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  target: 'node22',
  treeshake: true,
});
