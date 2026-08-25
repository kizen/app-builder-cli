# @kizenapps/cli

A local development environment for [Kizen](https://www.kizen.com) plugin apps.

`appbuilder` scaffolds a new plugin, bundles it, and runs a live viewer in a dedicated Chromium window so you can iterate on your plugin against any Kizen environment without having to publish, deploy, or reload by hand.

## Requirements

| Requirement               | Version            | Why                                                                                                                                                                                                                             |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                   | `>=20`             | Enforced by `engines` in `package.json`.                                                                                                                                                                                        |
| Google Chrome or Chromium | any recent release | The viewer is launched via [`chrome-launcher`](https://github.com/GoogleChrome/chrome-launcher) against a locally installed browser. No browser is bundled.                                                                     |
| Python                    | 3.12 or 3.13       | Only needed to execute code steps locally. The dev server builds a virtualenv with the interpreter the step's runtime asks for (`python-3-12` / `python-3-13`), matching the runtime images the hosted Kizen code-runner ships. |

`chrome-launcher` auto-discovers an installed Chrome/Chromium; if yours lives somewhere unusual, set `CHROME_PATH` to the executable and it will be preferred.

Python is resolved lazily — the CLI only looks for an interpreter the first time a plugin actually runs a code step, so you can build UI-only plugins without it.

## Installation

Run it without installing:

```sh
npx @kizenapps/cli dev
```

Or install it globally. The published binary is named `appbuilder`:

```sh
npm install -g @kizenapps/cli
appbuilder dev
```

Every commit to `main` publishes a prerelease under the `next` dist-tag (versioned `<version>-<short-sha>`); tagged releases go to `latest`. To pick up an unreleased fix:

```sh
npm install -g @kizenapps/cli@next
```

## Quickstart

### 1. Scaffold a plugin

```sh
appbuilder create
```

The wizard first asks where the plugin should live (the current directory, or a new sub-directory named after the API name), then collects five fields:

| Field         | Required | Notes                                                                                |
| ------------- | -------- | ------------------------------------------------------------------------------------ |
| Name          | yes      | Human-readable plugin name.                                                          |
| API name      | yes      | Defaults to a snake_cased version of the name. Hyphens are rejected by the platform. |
| External link | no       | Documentation or marketing URL for the plugin.                                       |
| Description   | no\*     | See the note below.                                                                  |
| Business ID   | no\*     | Prefilled from your stored credentials' business ID, when one exists.                |

> **Fill in Description and Business ID.** Both are labelled optional in the wizard, but `create` writes them into `kizen.json` as empty strings and the bundler rejects an empty `description` or `developer_business_id` — so a plugin created with those fields skipped fails `appbuilder build` until you edit `kizen.json` by hand. This is tracked internally (KZN-17594); until that fix lands, treat both as required.

`create` writes `kizen.json`, `src/`, `releaseNotes/`, and adds `.kizenapp/` to `.gitignore`.

### 2. Set up credentials

`appbuilder dev` talks to a real Kizen environment on your behalf, so it needs four things:

| Field       | Where it comes from                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------- |
| API Key     | An API key issued for your Kizen user, from the Kizen app.                                          |
| User ID     | The UUID of your Kizen user.                                                                        |
| Business ID | The UUID of the Kizen business you are developing against.                                          |
| Environment | One of `go`, `fmo`, `staging`, `integration`, `test1` — which Kizen deployment the above belong to. |

They are sent as `X-API-KEY` / `X-USER-ID` / `X-BUSINESS-ID` headers on every proxied request, so they must all belong to the same environment.

On the first `appbuilder dev` in a plugin directory you are prompted to pick a credential mode:

- **Global** — credentials are written to `~/.kizenappbuilder/credentials.json` (directory `0700`, file `0600`) and shared across every plugin on the machine. You can keep additional named profiles alongside it as `~/.kizenappbuilder/<profile>.json` and switch between them with `c` in the TUI.
- **Local** — nothing is written to disk by the CLI; you enter credentials inside the viewer, and they live in the browser profile under `.kizenapp/`.

The choice and the active profile name are remembered in `.kizenapp/config.json`, so subsequent runs load silently. `--credentials <path>` bypasses all of this and reads a specific JSON file.

### 3. Run the dev server

```sh
cd my-plugin
appbuilder dev
```

This builds the plugin, starts the local server on port 3121, and opens the viewer in a dedicated Chromium window. Every file change rebuilds and hot-reloads; if validation fails, the error appears in the TUI and the viewer keeps the last good bundle.

TUI keys: `v` launches the viewer (useful with `--no-viewer`), `c` switches credential profile, `q` quits.

### 4. Produce a bundle

```sh
appbuilder build
```

Writes `.kizenapp/bundle.json` — the same artifact `dev` serves — after running the full validation pass. Use this in CI or whenever you want a bundle without starting a server.

## Commands

### `appbuilder create`

Scaffolds a new Kizen plugin project. Interactive; no flags. See [Quickstart](#1-scaffold-a-plugin) for the fields it collects.

### `appbuilder build`

Reads the plugin in the current directory, validates it against the same rules enforced by the Kizen platform and Plugin Wizard, minifies sources, and writes `.kizenapp/bundle.json`. No flags.

If validation finds any errors (for example an `api_name` containing hyphens, which the platform rejects) the build fails and prints each issue grouped by file. Fix the reported issues and re-run.

### `appbuilder dev`

Starts the dev server and opens the viewer. Watches your plugin directory and rebuilds + hot-reloads the viewer on every change. Each rebuild runs the same validation as `build`.

| Flag                       | Default | Purpose                                                          |
| -------------------------- | ------- | ---------------------------------------------------------------- |
| `-p, --port <port>`        | `3121`  | Port the local dev server listens on                             |
| `-c, --credentials <path>` | —       | Use a specific credentials JSON file instead of a stored profile |
| `-d, --debug`              | off     | Show a CDP event panel in the TUI                                |
| `-v, --verbose`            | off     | Log every CDP event and handled error (implies `--debug`)        |
| `--no-viewer`              | —       | Don't auto-launch the viewer on startup (press `v` to launch it) |
| `--no-cache`               | —       | Disable the network proxy cache (always fetch upstream)          |

The viewer and the proxy cache are both on by default; the two `--no-*` flags turn them off.

### `appbuilder encrypt`

Encrypts a secret against a plugin's encryption keys and prints the envelope you paste into a `kizen.json` secret value:

```json
{ "encrypted": true, "value": "<base64>" }
```

The command talks to the Plugin Wizard host directly — `appbuilder dev` does **not** need to be running.

| Flag                       | Default                                 | Purpose                                                                                                                                      |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `-c, --credentials <path>` | global credentials                      | Path to a credentials JSON file                                                                                                              |
| `-a, --api-name <name>`    | `api_name` from `kizen.json` in the cwd | Plugin the secret belongs to                                                                                                                 |
| `-v, --value <value>`      | —                                       | Plaintext secret. Prefer piping on stdin — a flag value is visible in `ps`.                                                                  |
| `-s, --stage <dev\|prod>`  | `prod`                                  | Which encryption API to use. Defaulting is announced on stderr.                                                                              |
| `--remote`                 | off (encrypt locally)                   | Have the wizard's `/encrypt` endpoint do the crypto with the keypair it holds, instead of fetching the public key and encrypting in-process. |
| `-o, --out <path>`         | —                                       | Also write the envelope to a file as pretty JSON                                                                                             |

Interactive by default. When either stdin or stdout is not a TTY (CI, a redirect, a pipe) it switches to a headless flow: everything must come from flags, the secret may be piped in, and the compact single-line envelope goes to stdout with all diagnostics on stderr.

```sh
printf %s "$SECRET" | appbuilder encrypt -a my_plugin -s prod > secret.json
```

A failed `--out` write is a non-fatal warning — stdout already carries the envelope — but sets a non-zero exit code.

### `appbuilder report`

Generates a self-contained, browsable report of the plugin in the current directory: the `kizen.json` config, a file tree, and every source file. Two files are written — an HTML report and a Markdown one (same path with a `.md` extension), the latter being useful as LLM context.

| Flag                  | Default                                       | Purpose          |
| --------------------- | --------------------------------------------- | ---------------- |
| `-o, --output <path>` | `~/.kizenappbuilder/examples/<api_name>.html` | Output file path |

`developer_business_id` is stripped and every service's `auth_credentials` is redacted before rendering, so a report is safe to share.

### `appbuilder icons`

Prints every valid icon name accepted by toolbar items, pages, and adornments, one per line. No flags — pipe it to a pager or grep it.

```sh
appbuilder icons | grep calendar
```

## Reference

### Environment variables

The CLI reads four environment variables, all of which point it at a different Plugin Wizard (encryption API) host. Precedence for the `dev` target:

1. **`PLUGIN_WIZARD_URL`** — forces a single host for **all** targets, dev and prod alike.
2. **`PLUGIN_WIZARD_URL_DEV`** — explicit dev host.
3. **`APPBUILDER_LOCAL_DEV`** — any non-empty value routes the dev target to `http://localhost:9823`.
4. Default: `https://plugin-wizard.kizen.dev`.

Prod follows the same order minus step 3: `PLUGIN_WIZARD_URL`, then **`PLUGIN_WIZARD_URL_PROD`**, then the default `https://plugin-wizard.kizen.com`. An empty-string value is treated as unset at every level.

### The `.kizenapp/` directory

`build` and `dev` create `.kizenapp/` next to your `kizen.json` and add it to `.gitignore` automatically. It holds machine-local state only — **keep it gitignored**:

| Path          | Contents                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `bundle.json` | The packaged, minified, validated plugin bundle the viewer loads.                                                               |
| `config.json` | Per-project preferences: credential mode, active profile name, last viewed path, encryption target.                             |
| `.chrome/`    | The dedicated Chromium user-data directory for the viewer — cookies and session state included.                                 |
| `venv/`       | The Python virtualenv used to execute code steps locally. Rebuilt when its interpreter is too old for the bundled requirements. |

### Navigation context

Plugin scripts can attach a JSON context payload to an in-app navigation:

```js
this.openWindow('/some/path', '_self', { recordId: 'abc', mode: 'edit' });
```

The engine transmits that payload out of band through `sessionStorage` and appends a `session_data_key` to the URL; the destination page reads it back with `readNavigationContext` / `consumeNavigationContext` (or the `useAppNavigationContext` React hook). The sandbox surfaces this end to end:

- **Navigation Context panel** — a slide-out panel on the Routable Pages browser (toggled by the `context` button in its chrome, which shows a live event count) with a reverse-chronological log of every navigation that carried a context payload, plus any external `window.open` (which the engine drops context from). Each entry shows the target, whether a context payload rode along, its key and byte size, an expandable pretty-printed payload, and a status badge.
- **Simulated destination page** — navigating to an in-app path that isn't a routable page in your plugin renders a stand-in for the real Kizen page. When the URL carries a valid context key it shows the payload and lets you **Consume**, **Clear**, or **Re-read** it, so you can confirm the destination sees exactly what the script sent (and that a re-read after consuming sees nothing).

How the two navigation targets behave:

- **`_self`** (same-tab, relative) — the context stays in this tab's `sessionStorage` across the navigation, so the destination reads it normally. The sandbox reads (does not consume) it when logging.
- **`_blank`** (new-tab, relative, same origin) — the engine stores the context, opens the tab, then immediately deletes its own copy, relying on a real browser having already copied `sessionStorage` into the new tab.
- **External / cross-origin** URLs — context is never attached and is dropped by design; these appear in the log as `ignored (external)`.

**Fidelity limit:** a real `_blank` open gives the new tab its own `sessionStorage` copy. The sandbox has no real second tab, so the "opener" and the simulated destination share one `sessionStorage`; to keep the engine's reader helpers working, the harness snapshots the payload and re-inserts it under the same key immediately after the engine deletes it. Behavior matches a real browser for reading/consuming, but the two "tabs" are not truly isolated.

**Scope boundary:** navigating to a path that matches one of your plugin's own routable pages activates that page's tab without carrying the URL through, so the page cannot observe its own `session_data_key` via the simulated location. Use the simulated destination page (any non-routable in-app path) to inspect what a destination receives.

**Error surfacing:** if `sessionStorage` writes fail (e.g. quota exceeded, storage disabled), the engine navigates without context and reports a message through the same `onError` path every script artifact already uses — it shows in that artifact's result UI and the DevTools console, not as a separate log entry, because on failure the URL carries no key for the harness to detect. Note also that context is serialized with `JSON.stringify` inside the worker script: circular references and `BigInt` values throw there before any navigation happens, while functions, `undefined` values, and symbols are silently dropped.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for repository layout and build scripts.

## License

GPL-3.0-only. See [LICENSE.md](./LICENSE.md).
