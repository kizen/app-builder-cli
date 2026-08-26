# Contributing

Thanks for your interest in `@kizenapps/cli`. This document covers what you need to build and test the CLI itself. For using the published CLI, see the [README](./README.md).

## Prerequisites

Node.js 20 or newer and pnpm 9 are required. CI runs on Node 24. Every dependency resolves from the public npm registry, so `pnpm install` is all you need to get started.

## Repository layout

| Path      | What lives there                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/`    | The CLI. `commands/` holds one file per `appbuilder` subcommand (registered in `program.ts`), `ui/` is the Ink TUI, `server/` is the dev server, proxy, and local Python executor, `chrome/` launches and drives the viewer browser over CDP, and `lib/` holds shared helpers (credentials, config, bundling, encryption client). Built with `tsup` into a single ESM binary at `dist/index.js`. |
| `viewer/` | The browser SPA the dev server serves — React + TanStack Router/Query + Tailwind. It has its own `vite.config.ts` and its own `tsconfig.json`, and is built separately from the CLI.                                                                                                                                                                                                             |
| `shared/` | Code imported by both sides: credential/environment types, proxy helpers, the valid-icon list, file-extension tables.                                                                                                                                                                                                                                                                            |

Because `viewer/` compiles under a separate tsconfig, `pnpm typecheck` runs `tsc` twice — once for the CLI, once for the viewer. Anything in `shared/` must typecheck under both.

## Scripts

| Command          | What it does                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `pnpm build`     | Builds the CLI (`tsup`), the viewer (`vite build`), then `dist/THIRD-PARTY-NOTICES.txt`. |
| `pnpm watch`     | Runs both builds in watch mode, concurrently.                                            |
| `pnpm typecheck` | `tsc --noEmit` for the CLI and for `viewer/tsconfig.json`.                               |
| `pnpm lint`      | ESLint over `src`, `shared`, and `viewer/src`. `pnpm lint:fix` autofixes.                |
| `pnpm test`      | Runs the test suite (vitest).                                                            |
| `pnpm format`    | Prettier over the repo. `pnpm format:check` verifies without writing.                    |

CI (`.github/workflows/checks.yml`) runs lint, typecheck, test, and build on every pull request. Run those four plus `pnpm format:check` locally before pushing.

Adding a dependency has a licensing consequence worth knowing about before you reach for one. The viewer is a real bundle, so any package whose code lands in `dist/viewer` must have its license reproduced in `dist/THIRD-PARTY-NOTICES.txt`, which `pnpm build` derives from the actual module graph rather than from a hand-maintained list. A package that declares no license, declares `UNLICENSED`, or is a proprietary FontAwesome Pro package fails the build outright. Prefer dependencies under a permissive or GPL-compatible license, and run `pnpm build` after adding one.

## Trying your changes against a real plugin

`pnpm build` then `node /path/to/app-builder/dist/index.js dev` from inside a plugin directory runs your working copy. `pnpm watch` in one terminal plus that command in another gives you a fast edit loop; note the dev server must be restarted to pick up CLI-side changes, while viewer changes are served from the rebuilt bundle on reload.

## Releases

Publishing is automated. Every push to `main` publishes a prerelease to the `next` dist-tag, stamped as `<version>-<short-sha>`; pushing a `v*` tag verifies that `package.json` matches the tag and publishes to `latest`. Don't bump versions by hand in a pull request.

## License

By contributing, you agree that your contributions are licensed under the GPL-3.0-only license that covers this project. See [LICENSE.md](./LICENSE.md).
