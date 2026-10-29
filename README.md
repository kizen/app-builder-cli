# @kizenapps/cli

A local development environment for [Kizen](https://www.kizen.com) plugin apps.

`appbuilder` scaffolds a new plugin, bundles it, and runs a live viewer in a dedicated Chromium window so you can iterate on your plugin against any Kizen environment without having to publish, deploy, or reload by hand.

## Requirements

| Requirement               | Version            | Why                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                   | `>=20`             | Enforced by `engines` in `package.json`.                                                                                                                                                                                                                                                                                                 |
| Google Chrome or Chromium | any recent release | The viewer is launched via [`chrome-launcher`](https://github.com/GoogleChrome/chrome-launcher) against a locally installed browser. No browser is bundled.                                                                                                                                                                              |
| Python                    | 3.12 or newer      | Only needed to run code steps locally and for `appbuilder admin`. For code steps, the dev server builds a virtualenv with the interpreter the step's runtime asks for (`python-3-12` / `python-3-13`), matching the runtime images the hosted Kizen code-runner ships. `appbuilder admin` uses the newest Python 3.12 or newer it finds. |

`chrome-launcher` auto-discovers an installed Chrome/Chromium; if yours lives somewhere unusual, set `CHROME_PATH` to the executable and it will be preferred.

Python is resolved lazily — the CLI only looks for an interpreter the first time a plugin actually runs a code step, or the first time you run `appbuilder admin`, so you can build UI-only plugins without it.

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

| Field         | Required | Notes                                                                                                                       |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| Name          | yes      | Human-readable plugin name.                                                                                                 |
| API name      | yes      | Defaults to a snake_cased version of the name. Hyphens are rejected by the platform.                                        |
| External link | no       | Documentation or marketing URL for the plugin.                                                                              |
| Description   | no\*     | See the note below.                                                                                                         |
| Business ID   | no\*     | Prefilled from your `appbuilder login` session's business when you're signed in, else from your stored API-key credentials. |

> **Fill in Description and Business ID.** Both are labelled optional in the wizard, but `create` writes them into `kizen.json` as empty strings and the bundler rejects an empty `description` or `developer_business_id` — so a plugin created with those fields skipped fails `appbuilder build` until you edit `kizen.json` by hand. This is tracked internally (KZN-17594); until that fix lands, treat both as required.

It then asks which artifacts to scaffold — Floating frame, Block, Data adornment, Routable page, Toolbar item, Object settings item, JS action — with all seven selected by default (Space toggles, `a` selects all, `n` none). Each selected type gets a working `hello*` directory under `src/`, holding a `config.json` and a script that runs as-is.

`create` writes `kizen.json`, `src/`, `releaseNotes/`, a placeholder `src/thumbnail.png` (512×512, colored from the `api_name`), the templates for the artifacts you picked, and the Copilot review files described under [`appbuilder create`](#appbuilder-create). It adds both `.kizenapp/` and `.copilot-docs/` to `.gitignore`.

### 2. Set up credentials

> **API-key credentials are deprecated for block commands.** `appbuilder block push` and `appbuilder block targets` use your [`appbuilder login`](#appbuilder-login-logout-whoami-and-auth-header) session by default. `appbuilder dev` and `appbuilder encrypt` still use API keys: `encrypt` until Plugin Wizard accepts sign-in sessions, and OAuth for `dev` is planned. The rest of this section applies to them.

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

Scaffolds a new Kizen plugin project. Interactive by default; passing any flag other than `--include-lib` switches it to a non-interactive run, including `--artifacts` to choose the artifact templates up front (`appbuilder create --help` lists them all). Pass `--include-lib` to also write the Kizen data helper library to `src/lib/kizenData.js`; without it, no library is written. `--business-id` and `--environment` default from your `appbuilder login` session: the environment is `-e`, else the only environment you're signed in to, else `go`, and the business is that environment's session business. Only when you're signed out entirely does it fall back to `~/.kizenappbuilder/credentials.json`. See [Quickstart](#1-scaffold-a-plugin) for the fields it collects, the artifact picker, and everything it writes.

The scaffold also includes `.github/copilot-instructions.md`, two path-scoped instruction files under `.github/instructions/`, and `.github/workflows/copilot-code-review.yml`. That workflow fetches the Kizen plugin docs from `kizen/app-engine` into `.copilot-docs/` before Copilot code review runs, so reviews cite the current documentation instead of rules copied into the plugin repo. It only takes effect once it is on the repository's default branch, and `.copilot-docs/` is gitignored. Plugins scaffolded before this setup existed can pick it up with `appbuilder setup-copilot`.

It also writes the coding-agent skills, once for Claude Code (`.claude/skills/`) and once for Codex (`.agents/skills/`): `kizen-custom-block` (building custom blocks, with its design guide) and `kizen-business-apps` (publishing with [`appbuilder app`](#appbuilder-app)). Plugins scaffolded before a skill existed pick it up with [`appbuilder setup-claude`](#appbuilder-setup-claude) or [`appbuilder setup-codex`](#appbuilder-setup-codex).

### `appbuilder setup-copilot`

Writes the same Copilot review files into an existing plugin repo — run it from the repo root (a `kizen.json` must be there). The four files are CLI-owned, so the command overwrites them and prints `created`, `updated`, or `unchanged` per file; a clobbered local customization is recoverable from git. A file (or a folder on its path) that is a symbolic link is refused, and nothing is written. It also adds `.kizenapp/` and `.copilot-docs/` to `.gitignore` if they are missing.

| Flag        | Default | Purpose                                         |
| ----------- | ------- | ----------------------------------------------- |
| `--dry-run` | off     | Print the per-file statuses without writing any |

As with `create`, the workflow only runs once it has reached the repository's default branch.

### `appbuilder setup-claude`

Installs or refreshes the Claude Code skills in the plugin in the current directory: `kizen-custom-block` for building custom blocks (`.claude/skills/kizen-custom-block/SKILL.md`) and `kizen-business-apps` for publishing with [`appbuilder app`](#appbuilder-app) (`.claude/skills/kizen-business-apps/SKILL.md`). `appbuilder create` writes the skills once; run `setup-claude` in an existing plugin to add them, or after upgrading the CLI to pick up the bundled versions. With `--mcp` it only registers the Kizen MCP server instead and writes no files, so it can run in any directory (see below).

```sh
appbuilder setup-claude [--dry-run] [--include-lib]
appbuilder setup-claude --mcp [--env <env>] [--force] [--dry-run]
```

| Flag            | Default | Purpose                                                                                                        |
| --------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `--dry-run`     | off     | Report what would change without writing files.                                                                |
| `--include-lib` | off     | Also install the Kizen data helper library (`kizenData.js`).                                                   |
| `--mcp`         | off     | Only register the Kizen MCP server in Claude Code (user scope); writes no files, so it works in any directory. |
| `--env <env>`   | `go`    | Environment of the MCP server to register.                                                                     |
| `--force`       | off     | Replace an existing registration of that server.                                                               |

`--env` and `--force` only apply with `--mcp`, and `--mcp` can't be combined with `--include-lib`; see [Using the session from Claude Code](#using-the-session-from-claude-code-mcp).

It also installs the skill's design guide (`.claude/skills/kizen-custom-block/design.md`), which tells the agent how to make blocks match native dashlets. With `--include-lib`, it installs the Kizen data helper library that block scripts import to read records and apply the dashboard's date and team filters. The library goes under the `entry` directory from `kizen.json` (`<entry>/lib/kizenData.js`, one per entry in a multi-plugin `kizen.json`), and under `src/` when `kizen.json` has no usable `entry`. Without the flag, it refreshes only the libraries that already exist. `appbuilder create --include-lib` writes it to `src/lib/kizenData.js`.

It prints one line per file (`created`, `updated` or `unchanged`) and a one-line summary. These files are managed by the CLI, so local edits to them, including edits to `kizenData.js`, are replaced when they're `updated`. Don't edit `kizenData.js`; put your own helpers in another file under `src/lib/`. It only writes these files and never touches the `.github/` Copilot files, the Codex skills or block code. It writes only regular files inside the plugin folder: if a managed file, or any folder on its path, is a symbolic link, or something other than a file or folder is in the way, it writes nothing and fails with exit code 1, naming the path. That includes the entry directory: with `--include-lib` (or an existing `kizenData.js`), an entry directory such as `src` that is a symbolic link, as some monorepo setups use, is refused. Without `--mcp`, it also fails with exit code 1 when there's no `kizen.json` in the current directory.

`block push` and every [`appbuilder app`](#appbuilder-app) command add the warning `Claude files managed by appbuilder are out of date; run appbuilder setup-claude` to their result's `warnings` when the plugin has any of the Claude skills and any managed file is missing or differs from the bundled one: either skill's files, or an existing `kizenData.js`. A plugin installed before a skill existed is therefore out of date until `setup-claude` adds it. A plugin with no Claude skill gets no warning. The warning never fails the command, and only headless runs show it.

### `appbuilder setup-codex`

The same skills for Codex, which discovers repository skills in `.agents/skills/<name>/SKILL.md`: it installs or refreshes `.agents/skills/kizen-custom-block/` (with `design.md`) and `.agents/skills/kizen-business-apps/` in the plugin in the current directory. Both commands render the skills from the same templates; the Codex copies name `setup-codex`, `.agents/skills` and Codex's sandbox escalation where the Claude copies name `setup-claude`, `.claude/skills` and Claude Code's sandbox settings. `appbuilder create` writes both sets.

```sh
appbuilder setup-codex [--dry-run] [--include-lib]
```

| Flag            | Default | Purpose                                                      |
| --------------- | ------- | ------------------------------------------------------------ |
| `--dry-run`     | off     | Report what would change without writing files.              |
| `--include-lib` | off     | Also install the Kizen data helper library (`kizenData.js`). |

`--include-lib`, the per-file output, the summary (`Codex files: …`), the refusal to write through a symbolic link and the exit code 1 outside a plugin work as for `setup-claude`. The files are managed by the CLI, so a differing file is replaced without any flag. Inside Codex's sandbox `.agents/` is read-only, so an agent running `setup-codex` there needs to escalate it.

`block push` and every `appbuilder app` command add `Codex files managed by appbuilder are out of date; run appbuilder setup-codex` under the same rule as the Claude warning, judged on the Codex skills; a plugin with both sets can get both warnings.

There's no `--mcp`: Codex doesn't take an MCP headers helper from its CLI (`codex mcp add` has no flag for it), so registering one means editing `~/.codex/config.toml` by hand, and Codex gives the helper 10 seconds, which a first `npx` download of the pinned CLI can exceed.

### `appbuilder build`

Reads the plugin in the current directory, validates it against the same rules enforced by the Kizen platform and Plugin Wizard, minifies sources, and writes `.kizenapp/bundle.json`. No flags.

If validation finds any errors (for example an `api_name` containing hyphens, which the platform rejects) the build fails and prints each issue grouped by file. Fix the reported issues and re-run.

Automation step configs are validated the same way — parameter data types, secrets that must be declared in the manifest's `base_config.secrets`, fields removed from the publish contract, and `runtime` — against the list of automation data types bundled in `@kizenapps/packager`. The Plugin Wizard applies the same rules at publish, against the live list read from the target environment, so a build that passes locally is expected to publish clean.

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

The command talks to the Plugin Wizard host directly — `appbuilder dev` does **not** need to be running. It still uses API-key credentials (deprecated for block commands) until Plugin Wizard accepts sign-in sessions.

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

### `appbuilder block export`

Packages the plugin in the current directory (same validation and minification as `build`) and prints one block as pretty JSON — exactly what the Custom Block (AI Coded) dashlet's paste editor accepts. Nothing is written to `.kizenapp`.

```sh
appbuilder block export [api_name] [--copy]
```

| Argument / flag | Default                 | Purpose                                                                |
| --------------- | ----------------------- | ---------------------------------------------------------------------- |
| `[api_name]`    | the plugin's only block | Block to export. Required when the plugin has more than one block.     |
| `--copy`        | off                     | Also copy the JSON to the clipboard; a one-line status goes to stderr. |

Only the block JSON goes to stdout, so it can be piped or redirected (`appbuilder block export > block.json`). Validation warnings and errors go to stderr. The command fails with a non-zero exit code if validation fails, the block can't be found or is ambiguous, or the packaged block would be rejected by the paste editor (for example a block with no `script.js`, a non-positive-integer `min_w`, or a `min_w` greater than its `max_w`).

The JSON carries only the sizes the block's `config.json` writes: `min_w`, `max_w`, `min_h`, `max_h`, `default_w` and `default_h`. Sizes it leaves out are left out of the JSON too, rather than filled with packager defaults. `default_w` and `default_h` are the starting size, in grid columns and rows, of a dashlet created from the block. Each size that is set must be a positive integer, each `min_*` must be no greater than its `max_*`, and each `default_*` must fall within whichever of its `min_*` and `max_*` are set (for example `min_w` ≤ `default_w` ≤ `max_w`). Otherwise the export fails as `invalid_block` naming the field.

If the plugin has components in `src/views/`, the JSON also carries a `views` array: each packaged view's `api_name`, `name`, `type`, `script`/`html`/`css` (each left out when empty) and `event_scripts` (as a `[{ name, script }]` array), so the block can open one with `this.showViewInModal('<api_name>')`. Components in `src/pages/` are not included. Without views, the output is unchanged.

### `appbuilder block push`

Packages the plugin in the current directory (same validation as `block export`) and writes one block into a Custom Block (AI Coded) dashlet on a Kizen dashboard, homepage or chart group: it updates an existing dashlet or creates a new one. Card chrome (background, border, radius, shadow) comes from the dashboard's style settings, like native dashlets.

```sh
appbuilder block push [api_name] [flags]
```

Interactive by default: pick the environment (only when you pass no `--env` and you're signed in to several, or the account you name is saved in several), the block, the surface (dashboard, homepage or chart group), the dashboard, then whether to update an existing custom code dashlet or create a new one, and confirm. Pushing to a production environment (`go`, `fmo`) asks you to type `y`. In a TTY, `--yes` skips the confirm prompt only when the headless write gate would apply, so `go` and `fmo` still ask for a typed `y` unless `--allow-production` is also passed; `--dry-run` shows the plan without writing. A dashlet edited in Kizen since the last push still prompts before overwriting unless `--force` is passed.

It runs headless when stdin or stdout is not a TTY, under a coding agent or CI, or with `--json`, `--no-interactive` or `APPBUILDER_NO_INTERACTIVE` (see [Interactive or headless](#interactive-or-headless)). `--yes` never selects the mode. Headless runs never prompt: anything that would be a question fails with `needs_choice` and lists the choices.

| Argument / flag            | Default                                                                            | Purpose                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `[api_name]`               | the plugin's only block                                                            | Block to push. Required when the plugin has more than one block.                                          |
| `-c, --credentials <path>` | the sign-in session                                                                | API key (deprecated): credentials JSON file to use instead of the session                                 |
| `--profile <name>`         | the sign-in session                                                                | API key (deprecated): stored credential profile to use instead of the session                             |
| `--dashboard <id>`         | the remembered target                                                              | Dashboard, homepage or chart group to push to                                                             |
| `--dashlet <id>`           | matched by push history or name                                                    | Existing custom code dashlet to update. Needs `--dashboard`; can't be used with `--create`.               |
| `--create`                 | off                                                                                | Create a new dashlet instead of updating one                                                              |
| `--dry-run`                | off                                                                                | Resolve everything and print the request without writing                                                  |
| `--yes`                    | off                                                                                | Write without asking. Headless runs without it are dry runs.                                              |
| `--allow-production`       | off                                                                                | Allow headless writes to `go` / `fmo`                                                                     |
| `--force`                  | off                                                                                | Overwrite a dashlet that was edited in Kizen since the last push                                          |
| `--forget`                 | off                                                                                | Clear the remembered target for this block before resolving                                               |
| `--json`                   | off                                                                                | Print a JSON result to stdout (forces headless); the human summary goes to stderr                         |
| `--no-interactive`         | off (`$APPBUILDER_NO_INTERACTIVE`)                                                 | Run headless even at a terminal                                                                           |
| `--env <env>`              | the only signed-in environment, or with `--business` the only one where it's saved | Environment of the session to use. Not with `-c` or `--profile`.                                          |
| `--business <id or name>`  | `$APPBUILDER_BUSINESS`, else the current account                                   | Saved account to use, matched as for [`login --business`](#saved-accounts). Not with `-c` or `--profile`. |
| `--user <user id>`         | `$APPBUILDER_USER`                                                                 | With `--business`, the user id of that saved account. Not with `-c` or `--profile`.                       |

**Credentials.** Without `-c` or `--profile`, the push uses your [`appbuilder login`](#appbuilder-login-logout-whoami-and-auth-header) session for `--env`, or for the only environment you're signed in to. If you're signed in to several environments and pass no `--env`, the run is `needs_choice` with `choice: "environment"`. It uses that environment's current account, unless `--business` (and `--user`), or `APPBUILDER_BUSINESS` (and `APPBUILDER_USER`), names another saved account; then the environment without `--env` is the only one where that name matches a saved account, whether or not any account there is current, and several such environments are `needs_choice` the same way (see [Saved accounts](#saved-accounts)). If you're signed out, it fails with `not_signed_in`, whose `login.argv` is the `appbuilder login` command to run; it never falls back to an API key. API keys (deprecated) are used only with `-c <path>` or `--profile <name>`, and never touch the session; `--env`, `--business` or `--user` with either is a `usage_error`, and `APPBUILDER_BUSINESS` and `APPBUILDER_USER` are ignored. The credentials file must name a valid `environment` (`go`, `fmo`, `staging`, `integration`, `test1`); a missing or invalid one is refused with `credentials_invalid` rather than defaulting to production. Empty `apiKey`, `userId` or `businessId` are refused the same way. A `.kizenapp/config.json` `activeCredentialProfile` no longer selects an API key: the push uses the session and prints a one-line notice to stderr, so `--json` output stays clean. `credentialMode: "local"` doesn't affect block commands.

**Write gating (headless).** `--dry-run` is always a dry run. Without `--yes` the run is a dry run too, and stderr says `Dry run only: pass --yes to write.` With `--yes`, `go` and `fmo` also need `--allow-production` (else `production_requires_flag`). A dry run's `applyArgv` is the command that writes what it showed: the same push with `--yes`, pinned to its dashboard and dashlet (`--dashboard` plus `--dashlet` or `--create`) and to the account the run signed in as, with `--allow-production` only on production, where `requiresProductionConsent` is `true` so an agent asks the user first. If the target dashlet was pushed from here before and its content has since been changed in Kizen, both dry runs and writes stop with `drift_detected` unless `--force` is passed.

**Remembered target.** A successful write records the target in `.kizenapp/pushes.json` (kept gitignored): one entry per environment, business, plugin and block. Pushing the block somewhere else replaces the entry. With no `--dashboard`, the next push goes to the remembered dashlet. If that dashboard or dashlet is gone, the push fails with `remembered_target_missing` and never silently creates a new one. When only the dashlet is gone the failure lists the dashboard's target `choices`, and `--create` adds a new block there; otherwise pass `--dashboard <id>` to choose another target, or `--forget` to clear it (honored in dry runs too; the result then carries `"forgotten": true`). A missing `pushes.json` just means nothing is remembered yet; one that can't be read, isn't valid JSON, or isn't a JSON array fails the push with `local_error` before anything is written, so fix or delete it.

**Size.** A dashlet created by `push` starts `default_w` columns wide, or `min_w` when there's no `default_w`, or 6 when neither is set. Its height works the same way with `default_h`, then `min_h`, then 3 rows. That size is clamped into whichever of `min_*`/`max_*` the block's `config.json` sets, then into the grid (2 to 12 columns, 1 to 99 rows). The pushed content carries exactly the sizes `config.json` writes, the same as `block export`. Updating an existing dashlet never changes its layout or size.

The pushed content includes the plugin's `src/views/` components as `views`, in the same shape as `block export`. They count toward drift detection: a view changed in Kizen since the last push stops the push with `drift_detected`. Blocks in plugins without views push exactly as before, and existing `pushes.json` entries stay valid.

`block export` and `block push` fail with `invalid_block` if a view's `api_name`, `name`, `script`, `html`, `css` or event script contains a NUL character or `{__ref:`. The field is reported as `views.<api_name>.<field>`. A warning `appbuilder/views-unmatched` appears if some `src/views/` components couldn't be matched to packaged views.

**Matching.** With `--dashboard` and neither `--dashlet` nor `--create`, the push updates the dashlet recorded in `.kizenapp/pushes.json` for that dashboard, else the single custom code dashlet named `appbuilder:<plugin_api_name>/<block_api_name>` (the name given to every dashlet `push` creates). No match, or several, is `needs_choice`.

#### JSON output

With `--json`, every result is one pretty-printed JSON object on stdout, and the human summary goes to stderr. Headless without `--json` prints human text instead: success and dry-run output on stdout, errors on stderr. A dry run:

```json
{
  "ok": true,
  "applied": false,
  "dryRun": true,
  "reason": "no_yes",
  "action": "update",
  "environment": "staging",
  "businessId": "b0c6…",
  "dashboard": { "id": "5f1e…", "name": "Sales overview", "type": "dashboard" },
  "dashletId": "9a2d…",
  "url": "https://v2.staging.kizen.com/dashboard/5f1e…",
  "resolvedBy": "remembered",
  "block": {
    "pluginApiName": "my_plugin",
    "apiName": "pipeline_summary",
    "name": "Pipeline summary"
  },
  "method": "PATCH",
  "path": "/dashboards/5f1e…/dashlet/9a2d…",
  "body": { "config": { "…": "…" } },
  "warnings": [],
  "applyArgv": [
    "appbuilder",
    "block",
    "push",
    "pipeline_summary",
    "--env",
    "staging",
    "--business",
    "b0c6…",
    "--user",
    "7d1f…",
    "--dashboard",
    "5f1e…",
    "--dashlet",
    "9a2d…",
    "--yes",
    "--json"
  ],
  "requiresProductionConsent": false
}
```

`reason` is `flag` (`--dry-run`) or `no_yes` (headless without `--yes`). `action` is `create` or `update`, `method` is `POST` or `PATCH`, and `dashletId` is `null` for a create. `resolvedBy` is `flag`, `remembered`, `push_map` or `name`. `dashboard.type` is `dashboard`, `homepage` or `chart_group`.

An applied write:

```json
{
  "ok": true,
  "applied": true,
  "dryRun": false,
  "action": "created",
  "environment": "staging",
  "businessId": "b0c6…",
  "dashboard": { "id": "5f1e…", "name": "Sales overview", "type": "dashboard" },
  "dashletId": "c41b…",
  "url": "https://v2.staging.kizen.com/dashboard/5f1e…",
  "refresh": {
    "dashboardId": "5f1e…",
    "script": "await window.__kizenCustomBlocks?.refresh('5f1e…')"
  },
  "resolvedBy": "flag",
  "block": {
    "pluginApiName": "my_plugin",
    "apiName": "pipeline_summary",
    "name": "Pipeline summary"
  },
  "remembered": true,
  "warnings": []
}
```

`action` is `created` or `updated`. `remembered` is `false` (with a warning) when `.kizenapp/pushes.json` couldn't be written; the push itself still succeeded.

`refresh` is only on applied writes, and only when the dashboard id is a uuid; otherwise it's left out. `script` is exactly `await window.__kizenCustomBlocks?.refresh('<dashboardId>')`. Run it in a Kizen tab that already has `url` open to refetch that dashboard in place instead of reloading the page. The hook is registered on dashboards, homepages and chart groups. When it's available on the page, the script resolves to `{ refreshed: true, dashboardId }`. Otherwise it resolves to `undefined`: the page is an older Kizen build without the hook. `refreshed: true` means the dashboard query was invalidated, not that the target was on screen, which is why the agent matches the tab by `url` and screenshots afterwards. Human output prints the same script on a `Refresh an open tab:` line after the URL.

A failure exits 2 when it stops for a decision (`needs_choice`) and 1 otherwise:

```json
{
  "ok": false,
  "code": "needs_choice",
  "message": "Choose a block to update on \"Sales overview\", or create a new one; pass --dashlet <id> or --create.",
  "choice": "target",
  "choices": [
    {
      "value": "9a2d…",
      "label": "Pipeline summary",
      "args": ["--dashboard", "5f1e…", "--dashlet", "9a2d…"],
      "pushKey": "appbuilder:my_plugin/pipeline_summary",
      "isFromThisPlugin": true,
      "argv": [
        "appbuilder",
        "block",
        "push",
        "pipeline_summary",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--dashboard",
        "5f1e…",
        "--dashlet",
        "9a2d…",
        "--json"
      ]
    },
    {
      "value": "new",
      "label": "Create a new block",
      "args": ["--dashboard", "5f1e…", "--create"],
      "argv": [
        "appbuilder",
        "block",
        "push",
        "pipeline_summary",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--dashboard",
        "5f1e…",
        "--create",
        "--json"
      ]
    }
  ]
}
```

Optional failure fields: `choice` (`environment`, `block`, `dashboard` or `target`) and `choices` with `needs_choice`, `remembered_target_missing` and a `--dashlet` that is `not_found`; `issues` (the packager's validation issues) with `validation_failed`; `field` with `invalid_block`; `hint` (what to do next) with `not_signed_in`, `auth_failed`, `forbidden`, `session_store_unwritable` and others; `login` (`{ "argv": [...] }`, the `appbuilder login` command for the user to run) with `not_signed_in`; and `sandbox` (`"codex_network_disabled"`) on a `network_error` when Codex's sandbox has the network turned off. Each choice's `argv` is the whole command that selects it: the push re-run with that choice and the account flags (`--json` too when the run had it), without `--yes`, so it's a dry run whose `applyArgv` then writes. Run it as given. `args` are only the flags that select it (dashboard choices also carry `surface` and `canEdit`).

| Code                        | Meaning                                                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `needs_choice`              | An environment, block, dashboard or target must be chosen; see `choice` and `choices`                                                                                                                     |
| `validation_failed`         | The plugin failed validation                                                                                                                                                                              |
| `invalid_block`             | The plugin has no blocks, or the block would be rejected (`field` names the problem)                                                                                                                      |
| `not_signed_in`             | No usable sign-in session (missing, expired, rejected or unreadable); `login.argv` is the `appbuilder login` command for the user to run                                                                  |
| `credentials_invalid`       | The `-c`/`--profile` file can't be read, its `environment` is missing or invalid, or it lacks `apiKey`, `userId` or `businessId`                                                                          |
| `auth_failed`               | Kizen rejected the credentials                                                                                                                                                                            |
| `forbidden`                 | The credentials can't access the dashboard                                                                                                                                                                |
| `not_found`                 | The dashboard, or the `--dashlet` on it, doesn't exist                                                                                                                                                    |
| `remembered_target_missing` | The remembered dashboard or dashlet is gone; nothing is created without `--create`                                                                                                                        |
| `drift_detected`            | The dashlet was edited in Kizen since the last push; `--force` overwrites                                                                                                                                 |
| `production_requires_flag`  | `--yes` against `go` / `fmo` without `--allow-production`                                                                                                                                                 |
| `usage_error`               | Conflicting flags (`--dashlet` with `--create`, `--dashlet` without `--dashboard`), a non-custom-code `--dashlet`, or a `--business` (or `APPBUILDER_BUSINESS`) that matches no saved account, or several |
| `network_error`             | Kizen couldn't be reached; `sandbox: "codex_network_disabled"` when Codex's sandbox has the network off                                                                                                   |
| `session_store_unwritable`  | The session couldn't be saved to `~/.kizenappbuilder/oauth/` (a sandbox, or a full disk); `hint` says how to allow it                                                                                     |
| `api_error`                 | Any other Kizen API failure                                                                                                                                                                               |
| `local_error`               | A local failure that isn't a validation error: no `kizen.json`, packaging, reading `.kizenapp/pushes.json`, or writing it for `--forget`                                                                  |

Sign-in sessions add these cases: not being signed in, or a session that needs a new `appbuilder login` (expired, rejected or unreadable), is `not_signed_in` with `login.argv` (`appbuilder login`, plus `--env` when the environment is known and `--business`/`--user` when the run named an account); several signed-in environments and no `--env` is `needs_choice` (`choice: "environment"`, each choice `{ value, label, args: ["--env", <env>], argv }`), and so is a `--business` (or `APPBUILDER_BUSINESS`) that matches saved accounts in several environments, whose retry commands keep `--business` and `--user`; `--env`, `--business` or `--user` with `-c` or `--profile`, or an unknown `--env`, is `usage_error`; a `--business` (or `APPBUILDER_BUSINESS`) that matches no saved account, or several, is `usage_error` with a message that lists them, and so is `--user` without `--business` (or `APPBUILDER_USER` without `APPBUILDER_BUSINESS`); an unreachable token endpoint is `network_error`; a refreshed session that can't be saved is `session_store_unwritable`; and any other failure to refresh the session is `api_error`.

### `appbuilder block targets`

Lists where a block can be pushed: the business's dashboards and homepages plus its custom objects, or with `--object` one custom object's chart groups. Always headless.

The CLI honors `HTTP_PROXY`/`HTTPS_PROXY` and `NO_PROXY` on Node versions that support it (24.14+, or with `NODE_USE_ENV_PROXY=1` set).

`customObjects` is sorted by name and ends with Contacts (`"fetchUrl": "client"`) when the CLI can look up the business's contacts object; Kizen doesn't list Contacts with the other custom objects, so if that lookup fails, Contacts isn't included. `--object <contacts id>` lists Contacts' chart groups like any other object's.

| Flag                       | Default             | Purpose                                                       |
| -------------------------- | ------------------- | ------------------------------------------------------------- |
| `-c, --credentials <path>` | the sign-in session | API key (deprecated): credentials JSON file to use            |
| `--profile <name>`         | the sign-in session | API key (deprecated): stored credential profile to use        |
| `--object <id>`            | —                   | List the chart groups of this custom object (or Contacts)     |
| `--json`                   | off                 | Print JSON instead of tables                                  |
| `--env <env>`              | as for `block push` | Environment of the session to use. Not with `-c`/`--profile`. |
| `--business <id or name>`  | as for `block push` | Saved account to use. Not with `-c`/`--profile`.              |
| `--user <user id>`         | as for `block push` | With `--business`, the user id of that saved account.         |

Credentials, `--env`, `--business` and `--user` work as for `block push` (see [`appbuilder login`](#appbuilder-login-logout-whoami-and-auth-header)).

```json
{
  "ok": true,
  "environment": "staging",
  "businessId": "b0c6…",
  "surfaces": {
    "dashboard": [
      {
        "id": "5f1e…",
        "name": "Sales overview",
        "type": "dashboard",
        "dashletsCount": 4,
        "employeeAccess": "Owner",
        "hidden": false,
        "canEdit": true
      }
    ],
    "homepage": []
  },
  "customObjects": [
    { "id": "71d0…", "objectName": "Deals", "fetchUrl": "pipeline" },
    { "id": "c3a9…", "objectName": "Contacts", "fetchUrl": "client" }
  ]
}
```

With `--object <id>` the shape is `{ ok, environment, businessId, object: { id, objectName, fetchUrl } | null, surfaces: { chart_group: [...] } }`. `canEdit` is `true` for `Owner`, `Admin` or `Edit` access and `null` when Kizen reports no access level. Failures use the same shape and codes as `block push`.

#### Agent loop

The sequence a coding agent follows to build a block and put it on a dashboard. After upgrading the CLI, run `appbuilder setup-claude` (or `appbuilder setup-codex`) so the agent's skill matches the new commands.

```sh
appbuilder block export <api_name>
appbuilder block targets --json
appbuilder block targets --object <object_id> --json        # chart groups only
appbuilder block push <api_name> --dashboard <id> --json    # needs_choice → choices (existing blocks + new)
appbuilder block push <api_name> --dashboard <id> [--dashlet <id> | --create] --dry-run --json
appbuilder block push <api_name> --dashboard <id> [--dashlet <id> | --create] --yes --json
# change requests: edit, re-validate, then
appbuilder block push <api_name> --yes --json               # remembered target, zero questions
```

After each applied push, an agent that can drive the user's browser refreshes the open tab instead of reloading it: find the tab whose origin and path match `url`, run `refresh.script` there, and check that the block rendered. If the script returns `undefined`, the hook isn't available on that page, so navigate the tab to `url` instead. If no tab has `url` open, open it in a new one. `refresh` is absent when the dashboard id isn't a uuid; navigate to `url` in that case.

Guardrails:

- Never pass `--allow-production` unless the user named production.
- Stop on `drift_detected` and ask the user before retrying with `--force`.
- On `needs_choice` (exit 2), ask the user using `choices` (labels to show), then run the chosen `argv` exactly as given.
- Run a dry run's `applyArgv` as given, and only after the user agreed; when `requiresProductionConsent` is `true`, only after they agreed to write to production.
- On `not_signed_in`, ask the user to run `login.argv` (it opens a browser).
- On `remembered_target_missing`, ask whether to `--create` a new block rather than creating one.

### `appbuilder app`

Publishes the plugin in the current folder as a Kizen Business App on the business you're signed in to. Each developer pushes their own preview of the app; publishing a preview makes it the next Live version, which every user of the business gets. The server numbers the releases (`kizen.json` `version` isn't sent).

```sh
appbuilder app versions                  # Live, released and preview versions, and this folder's base
appbuilder app push [--force] [--base-from-preview <id>]   # save this folder as your preview
appbuilder app publish [--force] [--expect-preview <id>]   # make your preview the next Live version
appbuilder app merge [--release <n>] [--base <n> | --accept-live-base]   # merge Live (or release n) into this folder
appbuilder app rollback <n>              # restore released version n as your preview
appbuilder app pull <n> [--out <dir>]    # download release n's source into a new folder
appbuilder app actions list              # the app's JS actions and the objects they're linked to
appbuilder app actions link <action> <object> [--menu | --no-menu]   # link a JS action to an object
appbuilder app actions unlink <action> <object>                      # remove that link
appbuilder app preview delete [--owner <userId>] [--expect-updated <ts>] [--delete-app]   # delete your preview (or another developer's)
```

At a terminal each command is interactive: it shows the plan and asks before writing, and production (`go`, `fmo`) needs a typed `y`. It runs headless when stdin or stdout is not a TTY, under a coding agent or CI, or with `--json`, `--no-interactive` or `APPBUILDER_NO_INTERACTIVE` (see [Interactive or headless](#interactive-or-headless)).

| Flag                            | Commands                                                            | Purpose                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-c, --credentials <path>`      | all                                                                 | API key (deprecated): credentials JSON file to use instead of the session                                                                                                      |
| `--profile <name>`              | all                                                                 | API key (deprecated): stored credential profile to use instead of the session                                                                                                  |
| `--dry-run`                     | push, publish, merge, rollback, actions link/unlink, preview delete | Show what would change without writing                                                                                                                                         |
| `--yes`                         | push, publish, merge, rollback, actions link/unlink, preview delete | Write without asking. Headless runs without it are dry runs.                                                                                                                   |
| `--allow-production`            | push, publish, rollback, actions link/unlink, preview delete        | Allow headless writes to `go` / `fmo` (`merge` writes only local files, so it has none)                                                                                        |
| `--menu`, `--no-menu`           | actions link                                                        | Show the action in the object's Perform Action menus, or not. A new link isn't shown unless `--menu`; an existing link keeps its setting unless one is passed.                 |
| `--force`                       | push                                                                | Push even though files still have merge conflict markers                                                                                                                       |
| `--base-from-preview <id>`      | push                                                                | Take this folder's base from your preview, while your preview is still source package `<id>`. Only a `base_required` choice prints it (see [`base_required`](#base_required))  |
| `--force`                       | publish                                                             | Publish even though Live changed since your preview was based on it, or its base is unknown. Never publishes a preview pushed again since it was reviewed (`preview_replaced`) |
| `--expect-preview <id>`         | publish                                                             | Publish only if your preview's source package is still `<id>` (a dry run's `applyArgv` carries it)                                                                             |
| `--release <n>`                 | merge                                                               | Merge release `<n>` instead of Live                                                                                                                                            |
| `--base <n>`                    | merge                                                               | The release this folder was copied from, when no base is recorded. A wrong one drops the changes made since then.                                                              |
| `--accept-live-base`            | merge                                                               | Record Live (or `--release`) as this folder's base without merging, after merging by hand                                                                                      |
| `--out <dir>`                   | pull                                                                | Folder to create (default `../<api_name>-v<n>`, next to the plugin folder)                                                                                                     |
| `--owner <userId>`              | preview delete                                                      | Delete this user's preview instead of yours (a user id, as `versions` lists in `previews[].previewOwner.id`)                                                                   |
| `--expect-updated <ts>`         | preview delete                                                      | Delete only if the preview's last update is still `<ts>` (a dry run's `applyArgv` carries it)                                                                                  |
| `--delete-app`                  | preview delete                                                      | Allow deleting the whole app when the preview is its only version (a dry run's `applyArgv` carries it only when it warned about that)                                          |
| `--json`                        | all                                                                 | Print one JSON result to stdout (forces headless); the human text goes to stderr                                                                                               |
| `--no-interactive`              | all                                                                 | Run headless even at a terminal (also `$APPBUILDER_NO_INTERACTIVE`)                                                                                                            |
| `--env`, `--business`, `--user` | all                                                                 | The session and saved account to use, as for [`block push`](#appbuilder-block-push)                                                                                            |

Credentials work as for `block push`: the `appbuilder login` session by default, an API key only with `-c` or `--profile`. Business Apps need the Marketplace › Business App Developer permission at the Delete/All level; without it the commands fail with `forbidden` and say so in `hint`.

#### Workflow

1. `appbuilder app versions` shows where things stand. Its `next` is `merge` when Live moved past this folder's base, else `push` then `publish`.
2. `appbuilder app push` saves this folder as your preview. Other developers' previews and Live don't change.
3. `appbuilder app publish` makes your preview the next Live version (`nextReleaseAtLeast` in the dry run). Before promoting it, it checks that Live hasn't moved since your preview's base, both in the dry run and again just before the write. Your preview's base is read from your preview on the server (see [Moving to another machine](#moving-to-another-machine)), so it doesn't matter which folder or machine pushed it.
4. When someone else published in between, publish fails with `publish_conflict`: run `appbuilder app merge`, resolve any conflict markers, then push and publish again.

The first push of an app that isn't on the business yet creates it (`published: false` in `versions` until then). A release needs a thumbnail; publishing a preview without one fails with `thumbnail_required`.

#### Headless write gate and JSON results

`push`, `publish`, `merge`, `rollback` and `preview delete` are dry runs headless unless `--yes` is passed, and `--yes` against `go` or `fmo` also needs `--allow-production` (else `production_requires_flag`). `merge` only writes local files, so it needs `--yes` but never `--allow-production`. `pull` writes only into a new folder and needs neither. `versions` is read-only.

A dry run:

```json
{
  "ok": true,
  "applied": false,
  "dryRun": true,
  "reason": "no_yes",
  "action": "push",
  "environment": "staging",
  "businessId": "b0c6…",
  "userId": "7d1f…",
  "app": { "baseApiName": "acme", "apiName": "acme_abc123", "name": "Acme", "liveVersion": "5" },
  "source": { "files": 12, "mode": "git", "bytes": 18342, "hash": "dfc2…" },
  "thumbnail": true,
  "preview": { "exists": true, "updated": "2026-10-20T00:00:00.000Z" },
  "base": { "version": "5", "source": "recorded", "liveMoved": false },
  "conflictMarkers": [],
  "notices": [],
  "warnings": [],
  "applyArgv": [
    "appbuilder",
    "app",
    "push",
    "--yes",
    "--env",
    "staging",
    "--business",
    "b0c6…",
    "--user",
    "7d1f…",
    "--json"
  ],
  "requiresProductionConsent": false,
  "next": []
}
```

`applyArgv` is the command that applies what the dry run showed: the same command with `--yes`, plus `--allow-production` on `go` or `fmo`, pinned to the account the run signed in as (`--env`, `--business`, `--user`, or the `-c`/`--profile` it was given) so that a switch to another account meanwhile can't redirect it. A `publish` dry run pins the preview it reviewed (`--expect-preview <id>`), a `merge` dry run the version it planned (`--release <n>`, plus `--base <n>` when the base came from the flag or was detected), `rollback` its version, and `preview delete` the preview's owner (`--owner <userId>`, even for your own), the preview it reviewed (`--expect-updated <ts>`) and, only when it warned that the app goes too, `--delete-app`. A `push` apply uploads the folder as it is when it runs. `requiresProductionConsent` is `true` exactly when `applyArgv` carries `--allow-production`: an agent asks the user before running it. A dry run's `next` is empty, so the only way on is `applyArgv`. A push's `base.source` says where its base came from: `recorded` (this folder's state), `never_published` (no Live version, so none is needed), `detected` (the folder matches a release exactly), `preview` (it matches your preview exactly, and the base is your preview's, read from the server) or `base_from_preview` (`--base-from-preview`). A publish's `conflictCheck` compares your preview's base, read from its lineage on the server, with Live: `baseLiveVersion` and `baseSourcePackageId` are the lineage's, and `reason` says why it's a conflict.

An applied write has `applied: true`, the command's results (`previewVersion`, `sourcePackageId` and `thumbnailId` for a push; `liveVersion` and `previousLiveVersion` for a publish; `status` and the file lists for a merge) and `next`, the commands that follow, each `{ "step", "argv" }`: a push is followed by a publish dry run (after the JS action link steps, when any action may need linking; see [`app actions`](#app-actions-linking-js-actions-to-objects)), a rollback by a publish dry run, a merge by push and publish dry runs. A merge that left conflict markers starts `next` with a step that has no command:

```json
{ "step": "resolve", "files": ["src/a.js"], "markers": { "local": "HEAD", "incoming": "live" } }
```

`remembered` is `false` (with a warning) when `.kizenapp/apps.json` couldn't be written; the write itself still succeeded.

A push adds the CLI's entries to `.gitignore` when they're missing and then zips the folder again, so the applied result's `source` describes the zip that was uploaded. If any file other than `.gitignore` changed since the plan (an edit made while the confirm was open, say), the push stops with `local_error` and uploads nothing; run it again to review the change.

A publish that can't confirm that the release is the preview it reviewed (the preview was pushed again from elsewhere, or the check failed) still publishes, but says in `warnings` that this folder's base wasn't advanced. The next publish from this folder then stops with `publish_conflict`; merge, push and publish again.

#### Failures and exit codes

With `--json` a failure is `{ "ok": false, "code", "message", "hint"?, … }` on stdout. Exit `0` is success, dry runs included; exit `2` means the command stopped for a decision (`needs_choice` or `base_required`) and its `choices` say how to go on; every other failure exits `1`. Each choice carries `argv`, the whole command to run as given: `--json` and the run's account flags are already in it.

```json
{
  "ok": false,
  "code": "base_required",
  "message": "No base version is recorded for this folder, and Live is v3. Merge Live into this folder, or record that it already contains Live, then push.",
  "choice": "base",
  "choices": [
    {
      "value": "merge",
      "label": "Preview merging Live v3 into this folder",
      "args": [],
      "argv": [
        "appbuilder",
        "app",
        "merge",
        "--release",
        "3",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--json"
      ]
    },
    {
      "value": "accept",
      "label": "This folder already contains Live v3",
      "args": [],
      "argv": [
        "appbuilder",
        "app",
        "merge",
        "--release",
        "3",
        "--accept-live-base",
        "--yes",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--json"
      ]
    }
  ]
}
```

| Code                       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `needs_choice`             | Signed in to several environments and no `--env`; each choice re-runs the command with one                                                                                                                                                                                                                                                                                                                                                                                                          |
| `base_required`            | No base is recorded for this folder and it doesn't match a release or your preview exactly (see below)                                                                                                                                                                                                                                                                                                                                                                                              |
| `publish_conflict`         | Live moved since your preview's base, or that base was replaced (`conflict.reason: "base_replaced"`), or your preview's source doesn't say what it's based on (`"base_unknown"`). `next` is the `merge` dry run; a `push` dry run for `base_unknown`; or a new `publish` dry run when your preview changed since it was reviewed (`"preview_replaced"`: `--expect-preview` no longer matches, or it was pushed again between the plan and the promote, `--force` and the terminal confirm included) |
| `unresolved_conflicts`     | Files still have merge conflict markers; `files` lists them. `push --force` pushes anyway.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `no_preview`               | You have no preview to publish; push first                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `preview_incomplete`       | Your preview has no source package; push again                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `preview_changed`          | `preview delete`: the preview was pushed again since the dry run (`--expect-updated` no longer matches), or deleting it would delete the whole app without `--delete-app`; nothing was deleted. `next` is a new `preview delete` dry run                                                                                                                                                                                                                                                            |
| `thumbnail_required`       | Your preview has no thumbnail, which a release needs; add one, push, then publish                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `source_invalid`           | The folder can't be zipped: no `kizen.json` in it, an unreadable `.kizenignore`, a folder the enclosing git repository ignores, or a file over 50 MiB (200 MiB in all)                                                                                                                                                                                                                                                                                                                              |
| `validation_failed`        | The plugin failed validation; `issues` lists the problems                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `forbidden`                | Missing the Business App Developer permission (`hint`)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `production_requires_flag` | `--yes` against `go` / `fmo` without `--allow-production`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `not_signed_in`            | No usable sign-in session; `login.argv` is the `appbuilder login` command for the user to run                                                                                                                                                                                                                                                                                                                                                                                                       |
| `session_store_unwritable` | The session couldn't be saved to `~/.kizenappbuilder/oauth/` (usually an agent's sandbox); `hint` says how to allow it                                                                                                                                                                                                                                                                                                                                                                              |
| `network_error`            | Kizen couldn't be reached; `sandbox: "codex_network_disabled"` when Codex's sandbox has the network off                                                                                                                                                                                                                                                                                                                                                                                             |
| `credentials_invalid`      | The `-c`/`--profile` API-key file is unusable                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `auth_failed`              | Kizen rejected the credentials                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `not_found`                | The version doesn't exist, the app isn't published to this business yet (`rollback`, `pull`, `merge`, `actions`, `preview delete`), there's no Live version to merge, no such JS action, object or link, or no such preview                                                                                                                                                                                                                                                                         |
| `usage_error`              | A bad argument, such as a version that isn't a release number, a `pull` folder that already exists, or `actions link`/`unlink` without `<action>` or `<object>` headless                                                                                                                                                                                                                                                                                                                            |
| `api_error`, `local_error` | Any other Kizen API failure, or a local one                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

#### `app actions`: linking JS actions to objects

A JS action template does nothing until it's linked to an object. A link belongs to the app's install on the business and names the template by its `api_name`, so it survives new previews and releases. Create links with these commands (or the Kizen UI); an app's setup assistant may also have a step for it.

`push`, `publish` and `versions` check the app's JS actions and warn about every one that may need linking, at a terminal and headless alike. With `--json` they carry the check as `jsActions`:

```json
{
  "status": "checked",
  "liveVersion": "5",
  "actions": [
    {
      "apiName": "hello_action",
      "name": "Say hello",
      "hintObjectName": "client_client",
      "status": "linked",
      "inLive": true,
      "links": [
        {
          "id": "8c1e…",
          "objectId": "41aa…",
          "objectName": "client_client",
          "label": "Contacts",
          "includePerformAction": true,
          "unlinkArgv": [
            "appbuilder",
            "app",
            "actions",
            "unlink",
            "hello_action",
            "41aa…",
            "--env",
            "staging",
            "--business",
            "b0c6…",
            "--user",
            "7d1f…",
            "--json"
          ]
        }
      ],
      "linkArgv": [
        "appbuilder",
        "app",
        "actions",
        "link",
        "hello_action",
        "<object>",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--json"
      ],
      "linkMenuArgv": [
        "appbuilder",
        "app",
        "actions",
        "link",
        "hello_action",
        "<object>",
        "--menu",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--json"
      ],
      "linkNoMenuArgv": [
        "appbuilder",
        "app",
        "actions",
        "link",
        "hello_action",
        "<object>",
        "--no-menu",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--json"
      ]
    },
    {
      "apiName": "other_action",
      "name": "Other",
      "hintObjectName": "client_client",
      "status": "unlinked",
      "inLive": true,
      "links": [],
      "linkArgv": [
        "appbuilder",
        "app",
        "actions",
        "link",
        "other_action",
        "<object>",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--json"
      ],
      "linkMenuArgv": [
        "appbuilder",
        "app",
        "actions",
        "link",
        "other_action",
        "<object>",
        "--menu",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--json"
      ],
      "linkNoMenuArgv": [
        "appbuilder",
        "app",
        "actions",
        "link",
        "other_action",
        "<object>",
        "--no-menu",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--json"
      ]
    }
  ],
  "next": [
    {
      "step": "actions",
      "argv": [
        "appbuilder",
        "app",
        "actions",
        "list",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--json"
      ]
    },
    {
      "step": "link",
      "argv": [
        "appbuilder",
        "app",
        "actions",
        "link",
        "other_action",
        "client_client",
        "--env",
        "staging",
        "--business",
        "b0c6…",
        "--user",
        "7d1f…",
        "--json"
      ]
    }
  ]
}
```

| Action `status` | Meaning                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linked`        | At least one link; `links` lists them, with the object and `includePerformAction` (whether it shows in the object's Perform Action menus; `null` when never set) |
| `unlinked`      | In the Live version (or the app isn't on the business yet) with no link                                                                                          |
| `unknown`       | Not in the Live version, only in a preview, so its links can't be listed. It may or may not be linked; link it like an `unlinked` one                            |

Every action, wherever it's listed (`jsActions.actions` on `push`, `publish` and `versions`, and `actions` from `actions list`), carries the commands that act on it, pinned like every printed command to the account the run signed in as (`--env`, `--business`, `--user`, or its `-c`/`--profile`) and with `--json` when the run had it: `linkArgv`, `linkMenuArgv` (the same with `--menu`) and `linkNoMenuArgv` (with `--no-menu`, which also turns an existing link's menu off) are `link` dry runs whose one element `<object>` is a placeholder. Replace exactly that element with an object's api name or id, and nothing else. Each listed link carries `unlinkArgv`, an `unlink` dry run naming its object by id.

The check's own `status` is `checked`, `not_installed` (the app isn't on the business yet; nothing is linked), `no_live_version` (no links can be listed yet) or `failed` (a request failed: `error`, and a notice; the command itself still succeeds). `next` has an `actions list` step whenever an action may need linking (or the check failed), and a `link` dry run per `unlinked` action with a hint object. An `unknown` action gets no `link` step of its own: it may already be linked, so pick its object with the user. An applied push checks the app as the push left it: after a first push, the app is installed with only your preview, so the check is `no_live_version` and every action `unknown`. An applied push puts these steps first in its own `next`, before `publish`; an applied publish, and `versions`, end their own `next` with them (a dry run's `next` stays empty).

Kizen lists only the links of templates in the install's Live version, which is why a preview-only action is `unknown`. Link one right after `appbuilder app push`, as you would a Live one; `link` notes that an existing link to that object can't be seen, and reports `already_linked` if there was one. On a Kizen environment that doesn't have the fix for linking preview-only actions (KZN-19521) yet, the link fails with `api_error` and a `hint` saying so: publish first, then link.

`appbuilder app actions list` (read-only) returns `{ ok, environment, businessId, userId, app, published, status, actions, warnings, next }`: the actions of the Live version and your preview, with `next` holding the `link` dry runs. `link` and `unlink` are writes: headless dry runs without `--yes`, `--allow-production` on `go` and `fmo`, and a dry run's `applyArgv` names the object by id (and, for `link`, the menu setting it showed). `<object>` is an object's api name (`client_client`), id, or display name ignoring case; Contacts counts. A name that matches several objects stops with exit 2 (`needs_choice`, `choice: "object"`), one choice per object by id. A `link` result has `jsAction`, `object`, `change` (`create`, `update` or `up_to_date`), `includePerformAction`, `existing` and, once applied, `status`: `created`, `updated`, `up_to_date` (nothing written), or `already_linked` (the server already had the link, and its menu setting was left alone: for an action only in a preview, a link made while its links can't be listed; for an action in Live, a link made after this command listed them, in which case run `appbuilder app actions list` and link it again to set the menu setting). A link belongs to the app's one install, shared by Live and every preview, and each user's version resolves it, so creating, removing or changing the menu setting of a link to an action in Live (`inLive: true`) changes what everyone using Live sees as soon as it's made; there's no preview of a link. The dry run (and the confirm at a terminal) warns about it in `warnings`, and so does the applied result. A preview-only action's link reaches only the users of a version that has the action, and a result that changed nothing (`up_to_date`, `already_linked`) carries no such warning. An `unlink` result has `jsAction`, `object`, `associationId` and `status: "unlinked"`; unlinking an action that's only in a preview fails with `not_found`, because its links can't be listed: publish it first.

At a terminal, `link` and `unlink` work like the other writes (the plan, then a confirm; a typed `y` on production). Leave out `<action>` or `<object>` to pick them: `link` asks for the action (with its status), then the object (type to filter; the action's hint object starts highlighted, and objects that share a display name are told apart by api name), then whether it shows in the Perform Action menus unless `--menu` or `--no-menu` was passed; `unlink` asks which of the listed links to remove. Esc at a picker or `n` at the confirm cancels without writing, and so does Ctrl+C before the write starts. When `push`, `publish` or `versions` finds actions that may need linking, it offers "Link JS actions now", which runs `link`'s pickers right there. Headless, both arguments are required: a missing one is a `usage_error` naming it.

#### `app preview delete`

`appbuilder app preview delete` deletes your preview of the app, with every install of it and its OAuth connections. `--owner <userId>` deletes another developer's preview instead (Kizen lets anyone with the Business App Developer permission do that); it takes a user id, not a name, and a user with no preview is `not_found`, with the previews in `hint`. It's a write like the others: a dry run headless without `--yes`, `--allow-production` on `go` and `fmo`, and at a terminal the plan and a confirm (a typed `y` on production). Esc or `n` at the confirm cancels, and so does Ctrl+C before the delete starts.

Users who were using the preview switch to their own preview, or Live, and Kizen notifies them. When the preview is the app's only version (no release and no other preview), Kizen deletes the whole app from the business, with its settings and secrets. A dry run warns about each of these, and about deleting someone else's preview:

```json
{
  "ok": true,
  "applied": false,
  "dryRun": true,
  "reason": "no_yes",
  "action": "preview delete",
  "environment": "staging",
  "businessId": "b0c6…",
  "userId": "7d1f…",
  "app": { "baseApiName": "acme", "apiName": "acme_abc123", "name": "Acme", "liveVersion": null },
  "owner": { "id": "7d1f…", "fullName": "Ada Lovelace", "yours": true },
  "preview": {
    "updated": "2026-10-20T00:00:00.000Z",
    "activeUsersCount": 2,
    "installedCount": 3,
    "otherActiveUsersCount": 1
  },
  "deletesApp": true,
  "notices": [],
  "warnings": [
    "This preview is the only version of Acme, so deleting it deletes the whole app from this business, with its settings and secrets.",
    "1 other user is using this preview."
  ],
  "applyArgv": [
    "appbuilder",
    "app",
    "preview",
    "delete",
    "--owner",
    "7d1f…",
    "--expect-updated",
    "2026-10-20T00:00:00.000Z",
    "--delete-app",
    "--yes",
    "--env",
    "staging",
    "--business",
    "b0c6…",
    "--user",
    "7d1f…",
    "--json"
  ],
  "requiresProductionConsent": false,
  "next": []
}
```

`activeUsersCount` counts everyone using the preview, its owner included; `otherActiveUsersCount` leaves you out (the users the delete switches and notifies). Either is `null` when Kizen doesn't say.

`applyArgv` reads the app again and refuses what the dry run didn't show: a preview that's gone is `not_found`; one pushed again since (its `updated` isn't `--expect-updated` any more) stops with `preview_changed`, and so does a delete that would now take the whole app with it when the dry run said the app stays (no `--delete-app`). A `--yes` run without `--delete-app` never deletes an app. At a terminal, deleting one takes a typed `y`, even with `--yes`, unless `--delete-app` is passed with it: `--yes --delete-app` is explicit consent and skips the confirm, as it does headless. When Kizen reports no last update for the preview (`preview.updated` is `null`), the dry run can't be pinned to it, so it has no `applyArgv` (and a notice says so). Nothing is deleted then. At a terminal the confirm re-checks the same way right before deleting. Kizen's delete takes no precondition, so a change in the moment between that last read and the delete itself can't be caught, as with `publish`'s promote.

The applied result adds `status: "deleted"` and `appDeleted`: `true` when the app no longer exists on the business afterwards (read again after the delete), `null` with a warning when that read failed. When the dry run said the app goes but another version appeared before the delete, the app stays: `appDeleted` is `false`, and the result says so. Deleting your own preview also forgets it in `.kizenapp/apps.json` (this folder's base stays), and `next` is a `push` dry run; deleting someone else's changes nothing here, and `next` is empty. When the app is deleted with the preview (`appDeleted: true`), whoever's preview it was, every base recorded here for the app is forgotten too, since it named a version of an app that's gone. A base recorded for an app that's no longer on the business is ignored in any case: the next `push` says so and records the base afresh, as for a new app.

#### Merging and conflict markers

`appbuilder app merge` three-way merges Live (or `--release <n>`) into this folder against the folder's recorded base, using `git` (it must be installed; the folder doesn't need to be a repository). Text conflicts get git's two-way markers: the side after `<<<<<<< HEAD` is this folder's file, the side before `>>>>>>> live` is the merged version's. The merge records which files have markers, and `app push` refuses with `unresolved_conflicts` until they're gone. An applied merge records the merged version as the folder's base, conflicts or not, so the next push is based on it. Files changed on both sides that aren't text keep your copy (`binaryConflicts`), files Live has but `.gitignore` or `.kizenignore` excludes here are not written (`ignoredIncoming`), and a file deleted on one side and edited on the other keeps the edit.

When the merge can't run (no usable base, or no `git`), the result's `kind` is `fallback`: applying it extracts the version's source into a new folder under `.kizenapp/` so you can merge by hand, and its `choices` record a base and merge from it (`--base <n>`) or record the version as already contained (`--accept-live-base`).

#### `base_required`

A folder with no recorded base (a fresh clone, or another developer's copy) can't be checked against Live. Its first `push` finds the base on its own when it can be sure of it: when the folder's files match your preview exactly, it takes your preview's base (`base.source: "preview"`; see below); otherwise, when they match Live or one of the latest releases exactly, that release (`"detected"`). Otherwise it stops with `base_required` and two choices: preview merging Live into the folder, or record that the folder already contains Live (`--accept-live-base`, only when that's true, or the next publish overwrites Live's changes).

When you have a preview whose base the server records, there's a third choice, "This folder continues your preview (based on vN)": `appbuilder app push --base-from-preview <id>`, a dry run that pushes this folder with your preview's base (`base.source: "base_from_preview"`). Pick it only when this folder really is your preview's source with more changes, for example the same work carried on from another machine; if the folder came from somewhere else, the next publish can overwrite Live's changes. It's never picked for you, `--yes` included. `<id>` pins the preview the choice was offered for: if your preview is pushed again in the meantime, the push doesn't take its base (a notice says so) and goes on as if the flag weren't given, so it can stop with `base_required` again.

With no base to merge from, the merge preview always comes back as a `fallback`. Its choices merge from the release the folder was copied from (`--base <n>`, one choice per recent release) or record the version as already contained. If you know which release the folder came from, run that `--base` choice: it merges like any other merge. A wrong one drops the changes made since then. If you don't know, apply the fallback: it extracts Live's source into `.kizenapp/live-v<n>-<time>/`, so you can merge its changes into the folder by hand and then record the base with the accept choice.

#### Moving to another machine

What your preview is based on lives on the server, in the preview itself: every source zip `push` and `rollback` upload carries a small record of the preview's base, its lineage (`.kizenapp/lineage.json` in the zip: the base's Live version, that version's source package, and a format version). It's never extracted into a folder and never counts when sources are compared. So:

- `publish` reads your preview's base from its source on the server, whichever folder or machine pushed it. Moving to another machine, or another folder, and publishing the preview you pushed elsewhere works as it did where you pushed it: no merge, no `--force`. A preview pushed again from somewhere else is judged by its own lineage.
- A `push` from a folder with nothing recorded takes your preview's base when the folder's files match your preview exactly, and otherwise offers it as the third `base_required` choice above.
- A preview whose record is missing or can't be read is never trusted: publish stops with `publish_conflict` and `conflict.reason: "base_unknown"`, and its `next` is a push dry run. Pushing this folder gives the preview a lineage; `--force` publishes it as it is.
- A base names a version by number, and Kizen doesn't say which app a version belongs to, so an app deleted and created again reuses the numbers. The lineage also names the base version's source package. When your preview's base is the version publish compares with but that version has another source package now, publish stops with `publish_conflict` and `conflict.reason: "base_replaced"` (never a silent match): merge Live into the folder as for any conflict. A push never takes a base from a lineage whose package no longer matches, and a base recorded in `.kizenapp/apps.json` (always with its package) is ignored, with a notice, once that version's package differs.

A preview pushed from this folder and then published outside `appbuilder app publish` (in Kizen, or from another machine) is recognised too: when Live's source package is the one this folder's last push uploaded, Live is that push, so it becomes this folder's base (with a notice, and recorded on the next write to `.kizenapp/apps.json`), and `versions` and `push` don't ask for a merge. That holds only while this folder's base is still the one it pushed with, as Live's own lineage says; after a merge or `--accept-live-base` (or for a preview restored with `rollback`) the recorded base stays.

A developer with no preview of their own (a new one, say) gets their base from a release the folder matches exactly, or stops with `base_required`; their first push puts their preview's base on the server. Reading the lineage costs one download of your preview's source per `publish` (and per `push` with nothing recorded). If that download fails, `publish` stops, `--force` included, since what the preview is based on can't be read; try again, or push again.

#### `rollback` and `pull`

`appbuilder app rollback <n>` restores released version `<n>` as your preview without touching Live; publish it to make it Live. It uploads version `<n>`'s files again (unchanged) with the restored preview's lineage, which says it's based on the current Live version, so publishing it from any machine replaces Live on purpose rather than stopping on a conflict. When the app has releases but no Live version, the restored preview is based on no Live version, and publishing it stops with `publish_conflict` (`live_moved`, against the latest release) like any preview from before that release. `appbuilder app pull <n>` downloads release `<n>`'s source into a new folder (`../<api_name>-v<n>` by default, or `--out <dir>`), refusing a folder that exists or holds the plugin, and records `<n>` as that folder's base so pushing from it is checked like any other folder.

#### What a push uploads

In a git work tree, the files `git ls-files --cached --others --exclude-standard` lists: tracked files, plus untracked ones `.gitignore` (and git's other excludes) don't drop. Outside git, every file in the folder minus what the root `.gitignore` excludes. In both cases the root `.kizenignore` (gitignore syntax) then excludes more; it can't add back a file the other rules dropped. Some files are never uploaded whatever either file says: `node_modules`, `.git`, `.kizenapp`, `.kizenappbuilder`, `.copilot-docs`, `__pycache__` and `dist` at any depth, and `.DS_Store`, `.env`, `.env.*`, `.npmrc` and `credentials.json`. A source with a file over 50 MiB, or over 200 MiB in all, is refused with `source_invalid` before anything is uploaded: those are the limits `pull`, `merge`, `rollback` and base detection read source zips with. Neither are the skill folders appbuilder manages for coding agents (`.claude/skills/` and `.agents/skills/` `kizen-custom-block` and `kizen-business-apps`), which `setup-claude` and `setup-codex` rewrite on every upgrade: merges skip them, and a pull of an older release that has them leaves them out. Your own skills in those folders are uploaded. Symbolic links are never followed. The dry run's `source.files` counts what would go, and `source.bytes` and `source.hash` describe the folder's files; the zip uploaded also carries the preview's lineage at `.kizenapp/lineage.json` (see [Moving to another machine](#moving-to-another-machine)).

#### State

`.kizenapp/apps.json` (gitignored) records, per environment, business, app and user, the release this folder's source is based on (with that release's source package), which preview this folder last saved, and the files a merge left markers in. Don't edit it. Your preview's base isn't in it: it's in the preview's lineage on the server, which publish reads. `merge`, `--accept-live-base`, `pull` (in the folder it creates), publishing a preview pushed from this folder (here, or outside the CLI: see [Moving to another machine](#moving-to-another-machine)) and `push` (which records the base it pushed with) move the folder's base; `push` and `rollback` write the preview's into its lineage. A recorded base whose version no longer exists, or whose version is another one now (the app deleted and created again), is ignored with a notice, and the next push asks for a base again (`base_required`).

#### For coding agents

`appbuilder create` and `appbuilder setup-claude` / `setup-codex` install the `kizen-business-apps` skill, which tells Claude Code and Codex how to use these commands. Its rules: always pass `--json`; run every `argv` (`applyArgv`, `choices[].argv`, `next[].argv`, `login.argv`, and a JS action's `linkArgv`, `linkMenuArgv`, `linkNoMenuArgv` and `unlinkArgv`) exactly as given, the only edit being to replace a `<object>` element with an object's api name or id; show the user each dry run before running its `applyArgv`, and get their explicit go-ahead first when `requiresProductionConsent` is `true`; on exit 2 present the `choices` (the merge preview, a dry run, is the only one to run unasked; "This folder continues your preview" only when the user says the folder really continues their preview); never pass `--force`, `--allow-production` or `--accept-live-base` unless the user asked for it; never edit `.kizenapp/`; after a push or publish, link every JS action `jsActions` reports as `unlinked` or `unknown` to an object the user confirms (its `linkMenuArgv` or `linkNoMenuArgv`, a dry run first), and unlink (a link's `unlinkArgv`) only when asked; delete a preview only when asked, and another developer's only when the user names it.

Under Claude Code's sandbox, add `"appbuilder *"` to `sandbox.excludedCommands` in your user settings (`~/.claude/settings.json`); Claude Code ignores a project's `excludedCommands` in strict mode. An allowed-domains list can't cover `appbuilder`: `push` uploads go to whichever file-storage host the Kizen server names for each upload, and sessions are written to `~/.kizenappbuilder`. Under Codex, run `appbuilder` with escalated permissions (`sandbox_permissions: "require_escalated"`, `prefix_rule: ["appbuilder"]`).

### `appbuilder login`, `logout`, `whoami` and `auth-header`

Browser sign-in, the default for `block push` and `block targets`. API keys are deprecated for these commands and are used only when you pass `-c` or `--profile`.

```sh
appbuilder login [--env <env>] [--business <id or name> [--user <user id>]]
appbuilder login [--env <env>] --list [--json]
appbuilder whoami [--env <env>] [--business <id or name> [--user <user id>]] [--json]
appbuilder logout [--env <env>] [--all | --business <id or name> [--user <user id>]]
appbuilder auth-header [--env <env>] [--business <business id> --user <user id>]
appbuilder block push [api_name] [--env <env>] [--business <id or name> [--user <user id>]] [flags]
appbuilder block targets [--env <env>] [--business <id or name> [--user <user id>]] [flags]
```

`login` opens Kizen's consent page in your browser and prints the URL in case the browser doesn't open. There, you pick the business the session is for. The CLI waits up to 5 minutes for the browser to return to `http://127.0.0.1:<port>/callback`. It uses OAuth 2.0 authorization code with PKCE (S256). It only trusts the server's OAuth metadata when its `issuer` is exactly the environment's origin (for example `https://staging.kizen.com`). It registers itself with the server on first use (dynamic client registration), so you don't need an API key or a client secret. A request to the callback with the wrong `state` gets a `400` and is otherwise ignored, so the sign-in keeps waiting for the real callback. Each session belongs to one user and one business, which the CLI looks up with `/auth/bootstrap` right after sign-in. If that lookup fails, nothing is saved. Signing in again to the same account replaces its session. A `block push` or `block targets` that's already running keeps to the account it started with: switching to another account meanwhile doesn't affect it, and neither does signing in again to the same account. Signing out of that account stops it with a sign-in error. If the browser shows an error instead of the consent page, the saved app registration is probably stale. The sign-in then times out and clears that app registration, so running `appbuilder login` again registers afresh.

#### Saved accounts

Every account you sign in to stays saved on this machine, and one of them is current for each environment. `whoami`, `auth-header`, `admin`, `block push` and `block targets` use the current one unless you name another.

To use another saved account for one command without switching, pass `--business <id or name>` (and `--user <user id>`) to `whoami`, `admin`, `block push` or `block targets`, or set `APPBUILDER_BUSINESS` (and `APPBUILDER_USER`) in its environment. The flags win over the variables, and the variables over the current account; an empty variable counts as unset. The value is matched as for `login --business` below, among the saved accounts of one environment. With `--env`, that environment. Without it, the only environment where the value matches a saved account; whether any account there is current doesn't matter. If it matches in several environments, the command fails, names them and asks for `--env`. If it matches nowhere, the environment is the only one with any saved accounts, current or not, and the command fails listing them; with saved accounts in several environments, pass `--env`. If it matches no saved account in the environment, or several, the command fails and lists them; it never falls back to the current account. Naming an account never changes which one is current. `auth-header` ignores the variables, so an MCP `headersHelper` always serves the current account.

To switch without the browser, which is how scripts and agents should do it:

```sh
appbuilder login --env staging --list           # one line per saved account; the current one is marked
appbuilder login --env staging --list --json    # [{ businessId, userId, businessName, fullName, email, current, readable }]
appbuilder login --env staging --business <business id or name>
appbuilder login --env staging --business <business id> --user <user id>   # two users of one business
```

`--business` picks the saved account whose business id is exactly the value, or else whose business name matches it, ignoring case. `--user` narrows that to the account with exactly this user id, for when two users of one business are saved; it only works together with `--business`. Before switching, the CLI checks that the saved session still works by calling `/auth/bootstrap` with it, refreshing the token first if it's about to expire. On success it prints the same output as a browser sign-in. If the value matches several saved accounts, the command fails and lists them with their business ids, so you can retry with an exact id. When the matches are users of the same business, the error lists their user ids and suggests `--business <id> --user <user id>`. Commands the CLI prints for you to run leave plain values bare and single-quote the rest, so they're safe to paste into a shell. A network or server error leaves the current account as it was and exits with an error. Neither form of `--list` ever prints a token.

Two cases fall back to the browser: the saved account's refresh token has expired or been rejected (the CLI deletes that saved account first), or no saved account matches `--business` (and `--user`), whatever else is saved. Before the browser opens, `login` prints a short explanation to stderr: why it needs the browser, that a sign-in window is opening, which business to choose on Kizen's consent page, and the URL to open by hand if no window appears. At a terminal it addresses you; otherwise it addresses the agent or script running the command, which should pass it on to the person who signs in. Because the URL and instructions print before the sign-in finishes, an agent should run `appbuilder login` as a background command and relay its stderr to the user while it waits. After the sign-in, the CLI checks the account: after an expired saved account it must be exactly that account, and with no saved match it must match `--business` by business id or name, and `--user` by user id when given. If it does, it becomes current as usual. If the person signed in to another business, or as another user, the new account is saved but not made current, the command prints which account it got and the commands to use it or to try again, and it exits with code 1. If that account is already the current one, it says so instead.

When both stdin and stdout are terminals and you pass neither `--business` nor `--list`, `login` shows a picker of the saved accounts, labeled by business name, business id and email, with "Sign in with the browser" as the last option. In every other case, `login` never prompts: without `--business` it runs the browser sign-in, and if accounts are saved it first prints a hint about `--business` and `--list` to stderr.

`whoami --json` prints `{ ok, environment, businessId, businessName, userId, fullName, email }` on stdout (`null` for what the session's identity doesn't say) and the usual lines on stderr. Its failures follow the `app` commands' contract: `{ ok: false, code, message, hint? }` with exit 1, `not_signed_in` carrying `login.argv` (the `appbuilder login` command to run), and `needs_choice` with `choice: "environment"` and exit 2 when you're signed in to several environments, each choice's `argv` a whole `appbuilder whoami … --json` command.

`logout` removes the current account's session and leaves the other saved accounts. `logout --business <id or name>` removes one saved account, matched the same way as for `login`; if it's the current account, you're signed out too. `logout --all` removes every saved account for the environment. When no environment has a current account, both `--business` and `--all` need `--env`.

| Command       | `--env` default                                                                            | What it does                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`       | `go`                                                                                       | Signs in with the browser, or switches to a saved account, and stores the session                                                                                                                                                                                     |
| `whoami`      | the only environment you're signed in to; with `--business`, the only one where it's saved | Calls `/auth/bootstrap` with the current account's session, or the saved account `--business` names, and prints the user and business. Tokens are never printed.                                                                                                      |
| `logout`      | the only environment you're signed in to                                                   | Deletes the current account's session, one saved account (`--business`), or all of them (`--all`). Local only: the refresh tokens stay valid on Kizen.                                                                                                                |
| `auth-header` | from the MCP server URL ([see below](#using-the-session-from-claude-code-mcp))             | Prints `{"Authorization":"Bearer <access token>"}` for a Claude Code MCP `headersHelper`. With `--business` and `--user` (used together, by id), it serves only that saved account, whether or not it's current; [`appbuilder admin`](#appbuilder-admin) passes them. |

The production write gate (`--allow-production`) and every other flag of `block push` and `block targets` work the same with a session as with an API key.

Sessions are stored in `~/.kizenappbuilder/oauth/` (directory `0700`, files `0600`), separate from API-key profiles. Each saved account has its own file, `<env>.<business id>.<user id>.json`, and `<env>.json` names the current account. Access tokens last an hour and refresh automatically: when less than a minute is left, or once after a `401`. Refresh tokens rotate on each use. Each process makes one refresh at a time, and every file is written atomically. Concurrent `appbuilder` processes may each refresh, which is safe because Kizen returns the same token pair when a refresh token is reused within 5 minutes. Before saving, a refresh re-reads the session: it keeps the newer tokens if another process already refreshed or you signed in again to the same account, and it fails with a sign-in error if you signed out of that account meanwhile. A switch to another account doesn't affect it. If the refresh token is rejected, the CLI keeps the tokens another process already refreshed to; otherwise it deletes that account's file, and the command asks you to run `appbuilder login` again (with `--env <env>` for an environment other than `go`). A refresh only ever writes or deletes its own account's file, and only `login` and `logout` change which account is current, so a refresh that finishes late can't undo a logout or a switch.

A session file that is corrupt or can't be read isn't treated as "not signed in". Commands that use it report the file's path and ask you to run `appbuilder login` (with `--env <env>` for an environment other than `go`). `appbuilder logout --env <env>` signs you out either way. If the session file is the problem, logout removes it. If `<env>.json` is the problem, logout removes that and leaves the saved accounts, and `logout --all` removes those too. `login --list` still lists a saved account whose file can't be read, by its ids.

#### Using the session from Claude Code (MCP)

Kizen's MCP server at `/api/mcp` accepts the same session. As a Claude Code `headersHelper`, `appbuilder auth-header` prints `{"Authorization":"Bearer <access token>"}` as one line on stdout, refreshing the token first if it's about to expire.

To set it up, run these from any directory:

```sh
npx @kizenapps/cli setup-claude --mcp --env staging
npx @kizenapps/cli login --env staging
```

`setup-claude --mcp` only registers the server `kizen-<env>` at user scope, by running `claude mcp add-json` (`--dry-run` only prints that command). It writes no files, in a plugin directory or anywhere else. The helper is pinned to the version of the CLI you ran it with. For CLI version 1.16.0, for example, it's equivalent to this POSIX-shell command:

```sh
claude mcp add-json --scope user kizen-staging '{"type":"http","url":"https://staging.kizen.com/api/mcp","headersHelper":"npx -y @kizenapps/cli@1.16.0 auth-header"}'
```

- An existing server with that name is left unchanged unless you pass `--force`. After upgrading the CLI, run `setup-claude --mcp --force` to pin the helper to the new version.
- `--force` only replaces the user-scope server. A server with the same name at local or project scope (for example, one you added by hand without `--scope user`) takes precedence over it in that project. Remove that one with `claude mcp remove kizen-<env>` (run in the project) if you want the user-scope server there.
- If the `claude` command isn't installed, it prints this command for you to run instead, and still succeeds.
- If you aren't signed in to that environment yet, it reminds you to run `appbuilder login` (with `--env <env>` for an environment other than `go`). If the saved session can't be read, it prints that error, with the file's path, instead. Either way the server is still registered.
- If registering fails, the command exits with code 1.

The helper runs through `npx`, which reuses its cached copy of the CLI (running `setup-claude` through `npx` fills that cache), so it starts in about a second. That works when Claude Code was started from a shell with `node` on `PATH`. If it wasn't (for example, with nvm and Claude Code launched outside a terminal), use absolute paths instead, from `which node` and `which appbuilder`: `"headersHelper":"/absolute/path/to/node /absolute/path/to/appbuilder auth-header"`. `appbuilder` starts with `#!/usr/bin/env node`, so the path to `appbuilder` alone isn't enough. Use the absolute paths too when testing a local or `pnpm link` build whose version isn't published, because `npx` can't fetch that version.

User scope is recommended: Claude Code then passes the helper its environment variables and doesn't wait for project trust before running it.

The helper picks the environment from the MCP server URL that Claude Code passes it in `CLAUDE_CODE_MCP_SERVER_URL`: the environment whose API origin (scheme, host and port) matches that URL's origin. A URL that matches no environment is an error, so a token is never sent to a server it doesn't belong to. If you also pass `--env`, it must name that same environment, or the helper fails without printing a token. When the variable isn't set (for example, when you run the command yourself), it uses `--env`, or the only environment you're signed in to.

Claude Code gives the helper 10 seconds, so `auth-header` uses shorter timeouts than the other commands: 5s in total for token requests, including a retry after another process's refresh. On failure, it prints one line to stderr, such as a reminder to run `appbuilder login` (with `--env <env>` for an environment other than `go`), and nothing to stdout.

`auth-header` prints a live access token by design: treat its output like a password. The token acts as you, in the one business you chose when signing in, until it expires (up to an hour).

### `appbuilder admin`

Runs Kizen's admin CLI, `kizen`, signed in with your `appbuilder login` session. You don't install `kizen` yourself: you only need Python 3.12 or newer on `PATH`.

```sh
appbuilder admin [--env <env>] [--business <id or name> [--user <user id>]] [--] <kizen args...>
appbuilder admin init [--force]
```

`--env` picks the session, and defaults to the only environment you're signed in to. `kizen` runs as that environment's current account, unless `--business` (and `--user`), or `APPBUILDER_BUSINESS` (and `APPBUILDER_USER`), names another saved account; then `--env` defaults to the only environment where that name matches a saved account (see [Saved accounts](#saved-accounts)). The wrapper's own options (`--env`, `--business`, `--user`, `-h`/`--help`) come first and end at the first other argument or at `--`. Everything after that goes to `kizen` verbatim, so `appbuilder admin status --help` shows `kizen`'s help, and `appbuilder admin --help` shows this wrapper's. `init` is the wrapper's own subcommand only as the first argument; `appbuilder admin -- init` passes `init` to `kizen`.

On first use, `appbuilder admin` installs `kizen` into a private virtual environment under `~/.kizenappbuilder/kizen/<version>-<sha>/` and reuses it afterwards without touching the network. `appbuilder admin init` does that ahead of time, and needs no session. It uses the newest of `python3.14`, `python3.13`, `python3.12` and `python3` that is 3.12 or newer, downloads the `kizen` release this CLI version pins (currently 0.3.0) from its GitHub release, checks its sha256, and installs it and its dependencies from PyPI with `pip`. Progress goes to stderr; stdout is `kizen`'s. Each time it makes a new install, it removes installs for other `kizen` versions that have gone unused for 30 days.

If the install is damaged (for example, the Python it was built with was removed), the command says so and changes nothing. `appbuilder admin init --force` deletes the install and installs it again. Don't run it while `appbuilder admin` is running, since a running `kizen` uses that install.

Under app-builder, `kizen` gets your session through `KIZEN_AUTH_HELPER`: it names `appbuilder auth-header --env <env> --business <business id> --user <user id>`, which `kizen` runs when it needs a token, and `KIZEN_BASE_URL`, `KIZEN_BUSINESS_ID` and `KIZEN_USER_ID` identify the session. With `--business` and `--user`, `auth-header` serves only that account, whether or not it's current, so switching accounts with `appbuilder login` while `kizen` runs doesn't affect it. `kizen` keeps the token for the life of its process and runs the helper again only after a `401`. If you sign out of that account while `kizen` runs, its next token fetch (at startup, or after a `401`) fails. The token never appears in `kizen`'s environment or arguments. `KIZEN_PROFILE` and `CLAUDE_CODE_MCP_SERVER_URL` are removed from its environment. Under app-builder, `kizen` refuses `init`, `envs list` and `upgrade` (`upgrade --check` reports that app-builder manages the install). The command exits with `kizen`'s exit code.

To try a local `kizen` build, set `APPBUILDER_KIZEN_WHEEL` to the path of a `kizen_builder-<version>-….whl`. It's installed instead of the pinned release, with no download or hash check.

## Reference

### Interactive or headless

`create`, `encrypt`, `login`, `block push` and every `app` command have an interactive terminal UI. They use it only when stdin and stdout are both terminals and nothing below asks for headless; otherwise they run headless and never prompt (`block push` and `app` then answer a question with a failure that lists the choices).

- `--json` (where the command has it) or `--no-interactive`.
- `APPBUILDER_NO_INTERACTIVE` set to anything but empty, `0` or `false`.
- A coding agent or CI: `CLAUDECODE` (Claude Code) or `CODEX_CI` (Codex) set to any value, `CI` set to anything but empty, `0` or `false`, or `TERM=dumb`.

Coding agents should pass `--json` anyway, so stdout is one JSON object.

### Environment variables

Four environment variables point the CLI at a different Plugin Wizard (encryption API) host. Precedence for the `dev` target:

1. **`PLUGIN_WIZARD_URL`** — forces a single host for **all** targets, dev and prod alike.
2. **`PLUGIN_WIZARD_URL_DEV`** — explicit dev host.
3. **`APPBUILDER_LOCAL_DEV`** — any non-empty value routes the dev target to `http://localhost:9823`.
4. Default: `https://plugin-wizard.kizen.dev`.

Prod follows the same order minus step 3: `PLUGIN_WIZARD_URL`, then **`PLUGIN_WIZARD_URL_PROD`**, then the default `https://plugin-wizard.kizen.com`. An empty-string value is treated as unset at every level.

**`CLAUDE_CODE_MCP_SERVER_URL`** is set by Claude Code when it runs `appbuilder auth-header`, which uses it to pick the environment (see [Using the session from Claude Code](#using-the-session-from-claude-code-mcp)).

**`APPBUILDER_BUSINESS`** and **`APPBUILDER_USER`** name a saved account for `whoami`, `admin`, `block push`, `block targets` and the `app` commands to use instead of the current one, like `--business` and `--user`, which win over them. `APPBUILDER_USER` only applies with `APPBUILDER_BUSINESS`, and an empty value counts as unset. `auth-header` ignores them, and so do `block push` and `block targets` with `-c` or `--profile` (see [Saved accounts](#saved-accounts)).

**`APPBUILDER_NO_INTERACTIVE`** makes every command with an interactive UI run headless, like `--no-interactive`. **`CLAUDECODE`**, **`CODEX_CI`**, **`CI`** and **`TERM=dumb`** do the same; see [Interactive or headless](#interactive-or-headless).

**`CODEX_SANDBOX_NETWORK_DISABLED`** is set to `1` by Codex when its sandbox has the network turned off. A `network_error` then carries `sandbox: "codex_network_disabled"` and a `hint` saying to re-run the command with escalated permissions.

**`APPBUILDER_KIZEN_WHEEL`** is the path of a local `kizen_builder-<version>-….whl` for `appbuilder admin` to install instead of the `kizen` release this CLI version pins, with no download or hash check (see [`appbuilder admin`](#appbuilder-admin)).

### The `.kizenapp/` directory

`build` and `dev` create `.kizenapp/` next to your `kizen.json` and add it to `.gitignore` automatically. It holds machine-local state only — **keep it gitignored**:

| Path          | Contents                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle.json` | The packaged, minified, validated plugin bundle the viewer loads.                                                                                                                     |
| `config.json` | Per-project preferences: credential mode, active profile name, last viewed path, encryption target.                                                                                   |
| `pushes.json` | The remembered `block push` targets: one dashlet per environment, business, plugin and block.                                                                                         |
| `apps.json`   | What `appbuilder app` knows about this folder: the release its source is based on, and the preview it last saved. Your preview's base is on the server, in its source. Don't edit it. |
| `.chrome/`    | The dedicated Chromium user-data directory for the viewer — cookies and session state included.                                                                                       |
| `venv/`       | The Python virtualenv used to execute code steps locally. Rebuilt when its interpreter is too old for the bundled requirements.                                                       |

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

**`sessionStorage` in the sandbox:** the "opener" and the simulated destination share one `sessionStorage`. To keep the engine's reader helpers working, the harness snapshots the payload and re-inserts it under the same key immediately after the engine deletes it. Reading and consuming the payload behave as they do in a browser.

**Your plugin's own pages:** navigating to a path that matches one of your plugin's routable pages activates that page's tab without carrying the URL through, so the page doesn't receive its `session_data_key`. To inspect what a destination receives, use the simulated destination page (any non-routable in-app path).

**Error surfacing:** if `sessionStorage` writes fail (e.g. quota exceeded, storage disabled), the engine navigates without context and reports a message through the same `onError` path every script artifact already uses — it shows in that artifact's result UI and the DevTools console, not as a separate log entry, because on failure the URL carries no key for the harness to detect. Context is serialized with `JSON.stringify` inside the worker script: circular references and `BigInt` values throw there before any navigation happens, while functions, `undefined` values, and symbols are omitted.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for repository layout and build scripts.

## License

GPL-3.0-only. See [LICENSE.md](./LICENSE.md).
