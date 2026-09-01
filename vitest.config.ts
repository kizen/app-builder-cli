import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { target: 'es2022' },
  test: {
    // CLI-side code only. The viewer SPA has its own tsconfig/build and is not
    // covered by this Node test environment.
    environment: 'node',
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts'],
    globals: false,
    // vitest replaces every `.css` import with an empty string unless it is
    // listed here, and that stub also swallows `.css?raw`. The scaffold
    // stylesheets are imported as raw text, so they must be let through.
    css: { include: [/src\/templates\/.*\.css(?:\?|$)/] },
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/lib/**', 'shared/lib/**', 'src/program.ts', 'src/server/requestHandler.ts'],
    },
  },
});
