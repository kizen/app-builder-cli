import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { defineConfig } from 'tsup';

/**
 * Inlines `import x from './file.ext?raw'` as the file's text, matching the
 * `?raw` convention Vite provides natively so the same imports work under
 * vitest. Used for the scaffold templates under src/templates/, which are kept
 * as real `.js` / `.css` / `.json` / `.md` files rather than string literals.
 */
const rawPlugin: Plugin = {
  name: 'raw',
  setup(build) {
    // The resolved path keeps its `?raw` suffix on purpose. tsup registers its
    // own plugins (notably postcss, `onLoad({ filter: /\.css$/ })`) ahead of
    // user plugins and without a namespace restriction, so a path ending in
    // `.css` would be claimed by the CSS loader before this plugin sees it.
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: `${resolve(args.resolveDir, args.path.replace(/\?raw$/, ''))}?raw`,
      namespace: 'raw',
    }));

    build.onLoad({ filter: /\?raw$/, namespace: 'raw' }, async (args) => {
      const filePath = args.path.replace(/\?raw$/, '');

      return {
        contents: await readFile(filePath, 'utf-8'),
        loader: 'text',
        // esbuild only auto-tracks watch dependencies in its own `file`
        // namespace; without this, `tsup --watch` never rebuilds on template edits.
        watchFiles: [filePath],
      };
    });
  },
};

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
    esbuildPlugins: [rawPlugin],
  },
]);
