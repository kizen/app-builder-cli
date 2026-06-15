import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    banner: {
      js: '#!/usr/bin/env node',
    },
    // Do not clean so we don't wipe out the viewer when in watch mode
    clean: false,
    minify: true,
    // Sourcemaps are shipped to npm (via the `files: ["dist"]` entry). They
    // ~double the dist size but give Node-side consumers readable stack
    // traces from the minified bundle.
    sourcemap: true,
    // Bundle .txt assets (e.g. python-requirements.txt) as inlined strings so
    // they are available at runtime without a separate file-copy step.
    loader: { '.txt': 'text' },
  },
]);
