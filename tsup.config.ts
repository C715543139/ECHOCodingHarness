import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
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
