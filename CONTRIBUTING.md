# Contributing

Thanks for your interest in `@kizenapps/cli`. This document covers what you need to build and test the CLI itself. For using the published CLI, see the [README](./README.md).

## Before you start: FontAwesome Pro token

**`pnpm install` will fail without a FontAwesome Pro license.** The viewer uses FontAwesome Pro icon packages, and `.npmrc` points the `@fortawesome` scope at the private FontAwesome registry using an auth token read from the environment:

```ini
@fortawesome:registry=https://npm.fontawesome.com/
//npm.fontawesome.com/:_authToken=${FONTAWESOME_TOKEN}
```

You must export a token from your own FontAwesome Pro account before installing:

```sh
export FONTAWESOME_TOKEN=<your-fontawesome-pro-token>
pnpm install
```

Without it, the install fails on the `@fortawesome/pro-*` packages with a 401. There is currently no free-icon fallback build, so contributors without a FontAwesome Pro license cannot build the project locally. If that blocks you, please open an issue describing the change you wanted to make — we would rather review a patch we build ourselves than lose the contribution.

The same limitation applies to CI: pull requests from forks run without repository secrets, so the install step of the checks workflow fails and their status checks show red regardless of the change's correctness. A maintainer will run the checks on your behalf during review.

Node.js 20 or newer and pnpm 9 are required. CI runs on Node 24.

## Repository layout

| Path      | What lives there                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`    | The CLI. `commands/` holds one file per `appbuilder` subcommand (registered in `index.ts`), `ui/` is the Ink TUI, `server/` is the dev server, proxy, and local Python executor, `chrome/` launches and drives the viewer browser over CDP, and `lib/` holds shared helpers (credentials, config, bundling, encryption client). Built with `tsup` into a single ESM binary at `dist/index.js`. |
| `viewer/` | The browser SPA the dev server serves — React + TanStack Router/Query + Tailwind. It has its own `vite.config.ts` and its own `tsconfig.json`, and is built separately from the CLI.                                                                                                                                                                                                           |
| `shared/` | Code imported by both sides: credential/environment types, proxy helpers, the valid-icon list, file-extension tables.                                                                                                                                                                                                                                                                          |

Because `viewer/` compiles under a separate tsconfig, `pnpm typecheck` runs `tsc` twice — once for the CLI, once for the viewer. Anything in `shared/` must typecheck under both.

## Scripts

| Command          | What it does                                                              |
| ---------------- | ------------------------------------------------------------------------- |
| `pnpm build`     | Builds the CLI (`tsup`) and then the viewer (`vite build`).               |
| `pnpm watch`     | Runs both builds in watch mode, concurrently.                             |
| `pnpm typecheck` | `tsc --noEmit` for the CLI and for `viewer/tsconfig.json`.                |
| `pnpm lint`      | ESLint over `src`, `shared`, and `viewer/src`. `pnpm lint:fix` autofixes. |
| `pnpm test`      | Runs the test suite (vitest).                                             |
| `pnpm format`    | Prettier over the repo. `pnpm format:check` verifies without writing.     |

CI (`.github/workflows/checks.yml`) runs lint, typecheck, and test on every pull request. Run those three plus `pnpm format:check` locally before pushing.

## Trying your changes against a real plugin

`pnpm build` then `node /path/to/app-builder/dist/index.js dev` from inside a plugin directory runs your working copy. `pnpm watch` in one terminal plus that command in another gives you a fast edit loop; note the dev server must be restarted to pick up CLI-side changes, while viewer changes are served from the rebuilt bundle on reload.

## Releases

Publishing is automated. Every push to `main` publishes a prerelease to the `next` dist-tag, stamped as `<version>-<short-sha>`; pushing a `v*` tag verifies that `package.json` matches the tag and publishes to `latest`. Don't bump versions by hand in a pull request.

## License

By contributing, you agree that your contributions are licensed under the GPL-3.0 license that covers this project. See [LICENSE.md](./LICENSE.md).
