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

It then asks which artifacts to scaffold — Floating frame, Block, Data adornment, Routable page, Toolbar item, Object settings item, JS action — with all seven selected by default (Space toggles, `a` selects all, `n` none). Each selected type gets a working `hello*` directory under `src/`, holding a `config.json` and a script that runs as-is.

`create` writes `kizen.json`, `src/`, `releaseNotes/`, a placeholder `src/thumbnail.png` (512×512, colored from the `api_name`), the templates for the artifacts you picked, and the Copilot review files described under [`appbuilder create`](#appbuilder-create). It adds both `.kizenapp/` and `.copilot-docs/` to `.gitignore`.

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

Scaffolds a new Kizen plugin project. Interactive by default; passing any flag other than `--include-lib` switches it to a non-interactive run, including `--artifacts` to choose the artifact templates up front (`appbuilder create --help` lists them all). Pass `--include-lib` to also write the Kizen data helper library to `src/lib/kizenData.js`; without it, no library is written. See [Quickstart](#1-scaffold-a-plugin) for the fields it collects, the artifact picker, and everything it writes.

The scaffold also includes `.github/copilot-instructions.md`, two path-scoped instruction files under `.github/instructions/`, and `.github/workflows/copilot-code-review.yml`. That workflow fetches the Kizen plugin docs from `kizen/app-engine` into `.copilot-docs/` before Copilot code review runs, so reviews cite the current documentation instead of rules copied into the plugin repo. It only takes effect once it is on the repository's default branch, and `.copilot-docs/` is gitignored. Plugins scaffolded before this setup existed can pick it up with `appbuilder setup-copilot`.

### `appbuilder setup-copilot`

Writes the same Copilot review files into an existing plugin repo — run it from the repo root (a `kizen.json` must be there). The four files are CLI-owned, so the command overwrites them and prints `created`, `updated`, or `unchanged` per file; a clobbered local customization is recoverable from git. It also adds `.kizenapp/` and `.copilot-docs/` to `.gitignore` if they are missing.

| Flag        | Default | Purpose                                         |
| ----------- | ------- | ----------------------------------------------- |
| `--dry-run` | off     | Print the per-file statuses without writing any |

As with `create`, the workflow only runs once it has reached the repository's default branch.

### `appbuilder setup-claude`

Installs or refreshes the Claude Code skill for building custom blocks (`.claude/skills/kizen-custom-block/SKILL.md`) in the plugin in the current directory. `appbuilder create` writes the skill once; run `setup-claude` in an existing plugin to add it, or after upgrading the CLI to pick up the bundled version.

```sh
appbuilder setup-claude [--dry-run] [--include-lib]
```

| Flag            | Default | Purpose                                                      |
| --------------- | ------- | ------------------------------------------------------------ |
| `--dry-run`     | off     | Report what would change without writing files.              |
| `--include-lib` | off     | Also install the Kizen data helper library (`kizenData.js`). |

It also installs the skill's design guide (`.claude/skills/kizen-custom-block/design.md`), which tells the agent how to make blocks match native dashlets. With `--include-lib`, it installs the Kizen data helper library that block scripts import to read records and apply the dashboard's date and team filters. The library goes under the `entry` directory from `kizen.json` (`<entry>/lib/kizenData.js`, one per entry in a multi-plugin `kizen.json`), and under `src/` when `kizen.json` has no usable `entry`. Without the flag, it refreshes only the libraries that already exist. `appbuilder create --include-lib` writes it to `src/lib/kizenData.js`.

It prints one line per file (`created`, `updated` or `unchanged`) and a one-line summary. These files are managed by the CLI, so local edits to them, including edits to `kizenData.js`, are replaced when they're `updated`. Don't edit `kizenData.js`; put your own helpers in another file under `src/lib/`. It only writes these files and never touches the `.github/` Copilot files or block code. It fails with exit code 1 when there's no `kizen.json` in the current directory.

`block push` adds the warning `Claude files managed by appbuilder are out of date; run appbuilder setup-claude` when the plugin has the skill and the skill or its design guide is missing or differs from the bundled one, or an existing `kizenData.js` differs from the bundled one. The warning never fails the push.

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

Interactive by default: pick credentials, the block, the surface (dashboard, homepage or chart group), the dashboard, then whether to update an existing custom code dashlet or create a new one, and confirm. Pushing to a production environment (`go`, `fmo`) asks you to type `y`. In a TTY, `--yes` skips the confirm prompt only when the headless write gate would apply, so `go` and `fmo` still ask for a typed `y` unless `--allow-production` is also passed; `--dry-run` shows the plan without writing. A dashlet edited in Kizen since the last push still prompts before overwriting unless `--force` is passed.

It runs headless when stdin or stdout is not a TTY, or when `--json` is passed. `--yes` never selects the mode. Headless runs never prompt: anything that would be a question fails with `needs_choice` and lists the choices.

| Argument / flag            | Default                         | Purpose                                                                                     |
| -------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| `[api_name]`               | the plugin's only block         | Block to push. Required when the plugin has more than one block.                            |
| `-c, --credentials <path>` | see resolution below            | Credentials JSON file to use                                                                |
| `--profile <name>`         | see resolution below            | Stored credential profile to use                                                            |
| `--dashboard <id>`         | the remembered target           | Dashboard, homepage or chart group to push to                                               |
| `--dashlet <id>`           | matched by push history or name | Existing custom code dashlet to update. Needs `--dashboard`; can't be used with `--create`. |
| `--create`                 | off                             | Create a new dashlet instead of updating one                                                |
| `--dry-run`                | off                             | Resolve everything and print the request without writing                                    |
| `--yes`                    | off                             | Write without asking. Headless runs without it are dry runs.                                |
| `--allow-production`       | off                             | Allow headless writes to `go` / `fmo`                                                       |
| `--force`                  | off                             | Overwrite a dashlet that was edited in Kizen since the last push                            |
| `--forget`                 | off                             | Clear the remembered target for this block before resolving                                 |
| `--json`                   | off                             | Print a JSON result to stdout (forces headless); the human summary goes to stderr           |

**Credentials** resolve in this order: `-c`, then `--profile`, then the project's active profile from `.kizenapp/config.json`, then the only loadable stored profile; several profiles without a choice is `needs_choice`. A project set to local browser-only credentials must pass `-c` or `--profile`. The credentials file must name a valid `environment` (`go`, `fmo`, `staging`, `integration`, `test1`); a missing or invalid one is refused with `credentials_invalid` rather than defaulting to production. Empty `apiKey`, `userId` or `businessId` are refused the same way.

**Write gating (headless).** `--dry-run` is always a dry run. Without `--yes` the run is a dry run too, and stderr says `Dry run only: pass --yes to write.` With `--yes`, `go` and `fmo` also need `--allow-production` (else `production_requires_flag`). If the target dashlet was pushed from here before and its content has since been changed in Kizen, both dry runs and writes stop with `drift_detected` unless `--force` is passed.

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
  "warnings": []
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

A failure exits 1:

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
      "isFromThisPlugin": true
    },
    { "value": "new", "label": "Create a new block", "args": ["--dashboard", "5f1e…", "--create"] }
  ]
}
```

Optional failure fields: `choice` (`profile`, `block`, `dashboard` or `target`) and `choices` with `needs_choice`, `remembered_target_missing` and a `--dashlet` that is `not_found`; `issues` (the packager's validation issues) with `validation_failed`; `field` with `invalid_block`; `hint` with `auth_failed` and `forbidden`. Each choice's `args` are the exact CLI arguments that select it, to be appended to the command (dashboard choices also carry `surface` and `canEdit`).

| Code                        | Meaning                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `needs_choice`              | A profile, block, dashboard or target must be chosen; see `choice` and `choices`                                                         |
| `validation_failed`         | The plugin failed validation                                                                                                             |
| `invalid_block`             | The plugin has no blocks, or the block would be rejected (`field` names the problem)                                                     |
| `credentials_invalid`       | No usable credentials, or the file's `environment` is missing or invalid                                                                 |
| `auth_failed`               | Kizen rejected the credentials                                                                                                           |
| `forbidden`                 | The credentials can't access the dashboard                                                                                               |
| `not_found`                 | The dashboard, or the `--dashlet` on it, doesn't exist                                                                                   |
| `remembered_target_missing` | The remembered dashboard or dashlet is gone; nothing is created without `--create`                                                       |
| `drift_detected`            | The dashlet was edited in Kizen since the last push; `--force` overwrites                                                                |
| `production_requires_flag`  | `--yes` against `go` / `fmo` without `--allow-production`                                                                                |
| `usage_error`               | Conflicting flags (`--dashlet` with `--create`, `--dashlet` without `--dashboard`), or a non-custom-code `--dashlet`                     |
| `network_error`             | Kizen couldn't be reached                                                                                                                |
| `api_error`                 | Any other Kizen API failure                                                                                                              |
| `local_error`               | A local failure that isn't a validation error: no `kizen.json`, packaging, reading `.kizenapp/pushes.json`, or writing it for `--forget` |

### `appbuilder block targets`

Lists where a block can be pushed: the business's dashboards and homepages plus its custom objects, or with `--object` one custom object's chart groups. Always headless.

The CLI honors `HTTP_PROXY`/`HTTPS_PROXY` and `NO_PROXY` on Node versions that support it (24.14+, or with `NODE_USE_ENV_PROXY=1` set).

`customObjects` is sorted by name and ends with Contacts (`"fetchUrl": "client"`) when the CLI can look up the business's contacts object; Kizen doesn't list Contacts with the other custom objects, so if that lookup fails the row is silently left out. `--object <contacts id>` lists Contacts' chart groups like any other object's.

| Flag                       | Default             | Purpose                                                   |
| -------------------------- | ------------------- | --------------------------------------------------------- |
| `-c, --credentials <path>` | as for `block push` | Credentials JSON file to use                              |
| `--profile <name>`         | as for `block push` | Stored credential profile to use                          |
| `--object <id>`            | —                   | List the chart groups of this custom object (or Contacts) |
| `--json`                   | off                 | Print JSON instead of tables                              |

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

The sequence a coding agent follows to build a block and put it on a dashboard. After upgrading the CLI, run `appbuilder setup-claude` so the agent's skill matches the new commands.

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
- On `needs_choice`, ask the user using `choices` (labels to show, `args` to append).
- On `remembered_target_missing`, ask whether to `--create` a new block rather than creating one.

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
| `pushes.json` | The remembered `block push` targets: one dashlet per environment, business, plugin and block.                                   |
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
