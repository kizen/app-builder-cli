---
name: kizen-custom-block
description: Use this skill when the user asks to build, change or publish a Kizen content block, custom block, chart, or dashboard/homepage visualization in this plugin. It covers the block file layout, the plugin engine runtime rules, and the appbuilder validate, preview and push loop.
---

# Kizen custom blocks

Follow these rules exactly. The runtime is strict, and a push changes a live Kizen dashlet.

## Keep this skill current

At the start of any block task, run `appbuilder setup-claude` in the plugin directory.

- If it reports `updated` for `.claude/skills/kizen-custom-block/SKILL.md`, your loaded copy of this skill is stale. Re-read `.claude/skills/kizen-custom-block/SKILL.md` before doing anything else, and follow the new copy.
- If it reports `created` for any file, or `updated` for `.claude/skills/kizen-custom-block/design.md`, read that file before writing any markup or styles.
- If it reports `created` or `updated` for `lib/kizenData.js` (under the plugin's entry directory, usually `src/`), re-read its exports before using them.
- If every file line reports `unchanged`, continue.
- If the command doesn't exist (an older CLI), skip it and continue.
- If it fails (for example, you aren't in the plugin directory that holds `kizen.json`), switch to that directory and run it once more. If it still fails, continue without it.

`setup-claude` only rewrites the CLI-managed files: the ones in this skill directory and `src/lib/kizenData.js`. It never touches block code, so it's always safe to run.

## What a block is

A block is a directory under `src/blocks/<dir>/`:

- `config.json` (required): `name`, `api_name` (always set it explicitly), `types` (any of `homepages`, `dashboards`, `charts` for chart groups, and `records`; a block only appears on the surfaces it lists), and the optional sizes `min_w`, `max_w`, `min_h`, `max_h`, `default_w` and `default_h`. Widths are grid columns (1 to 12) and heights are grid rows. Each size you set is a positive integer, each `min_*` is no greater than its `max_*`, and each `default_*` falls within whichever of its `min_*` and `max_*` you set. `default_w` and `default_h` are the starting size when `block push` creates a new dashlet; updates never resize an existing dashlet. Only the sizes you write are exported and pushed.
  - `host_chrome` (optional boolean, default `true`): whether the host paints the dashlet card around the block. Omit it unless you are turning chrome off. Only a value you write is exported and pushed, and any value other than `true` or `false` fails validation.
- `script.js` (required): the render script.
- `styles.css` (optional).
- `eventScripts/<name>.js` (optional): one file per interactive handler.

Shared helpers live in `src/lib/*.js`. Import them with relative named imports only, for example `import { formatMoney } from '../../lib/format.js';`. No default imports, no bare package names.

`src/lib/kizenData.js` is managed by appbuilder: `setup-claude` and CLI updates replace it. Never edit it. Put your own helpers in another file under `src/lib/`.

### Host chrome

Decide the mode yourself from the request. Ask the user only if they already raised it and their choice is unclear.

- Keep host chrome (omit `host_chrome`) for standard data dashlets such as charts, KPIs, tables and lists that should match native cards.
- Set `"host_chrome": false` for full-bleed heroes, imagery, custom-shaped cards, or any design whose background is part of the visual.

Chrome off, in `config.json`:

```json
{
  "name": "Welcome hero",
  "api_name": "welcome_hero",
  "types": ["homepages", "dashboards"],
  "host_chrome": false
}
```

Follow "Chrome off" in `design.md` for the layout rules. In your summary to the user, state which mode you chose and why in one line. `block push --dry-run --json` shows the value as `body.config.content.host_chrome` (absent when chrome is on by default), so check it there. Changing `host_chrome` on a block you already pushed is an ordinary update: validate, then `block push <api_name> --yes --json`.

## Runtime rules

Blocks run in the plugin engine web worker.

- `script.js` is the body of an async function, and `this` is the worker context. Use `await` at the top level.
- There is no DOM: no `document` or `window`. There are no npm packages. Don't use `eval` or `Function`.
- Render with `this.outputUI(htmlString)`. The output is sanitized with DOMPurify, so `<script>` tags and `on*` attributes are stripped. Don't rely on them.
- Charts are hand-built inline SVG strings. There are no chart libraries.
- Interactivity: put `data-script="<eventScriptName>"` on a `<button>` whose content is text only. Clicking it runs `eventScripts/<eventScriptName>.js` in a fresh worker, so no state carries over from `script.js`.
- Args:
  - `this.args.dateFilter`: `{ start, end }`, or `undefined`.
  - `this.args.teamFilter`.
  - `this.args.objectId`: set on chart groups.
  - Homepages have no date or team filter. Handle both being absent.
- Data: read records with the `kizenData.js` helpers (see "Reading Kizen data"). They call `this.getWithErrors` and `this.postWithErrors`, which use relative URLs and run as the viewing user.
- Toasts: `this.showToast(message, options)`. `message` MUST be a string. Passing an object crashes the host app.
- Styling:
  - The host applies `* { font-size: 10px }`. Set explicit px font sizes on everything.
  - With host chrome (the default), the host paints the card (background, border, border radius and shadow) from the dashboard's style settings, like native dashlets. The block root is transparent, fills the card, and paints no card of its own.
  - With `"host_chrome": false`, the host paints nothing: no background, border, radius or shadow. The block root fills the card edge to edge and owns its whole look (see "Chrome off" in `design.md`).
  - Put chart labels inside the SVG as `<text>` so they scale with the `viewBox`.
- The code is stored in a Kizen dashlet. Never include a NUL character or the literal text `{__ref:` anywhere in any file.

## Reading Kizen data

Read records through `src/lib/kizenData.js`. Always import it from `../../lib/kizenData.js`. Its helpers take the worker context as their first argument, so pass `this`.

- `getFields(this, object)` loads an object's fields. `object` is the object's id or name, and Contacts is `client_client`. Match fields by `name`.
- `blockFilters(this.args, fields)` returns `{ filters, unapplied }`. Always apply `filters`, so the block reacts to the dashboard's date and team filters the way native dashlets do (date on `created`, team on `owner`). When `unapplied` contains `'teamFilter'`, the team filter couldn't be applied (a roles-only selection, or an object with no owner field). Show "(team filter not applied)".
- `dropdownFilter(field, 'Name')` or `dropdownFilter(field, ['A', 'B'])` filters a dropdown by option names.
- `searchRecords(this, { object, fieldNames, filters })` returns `{ records, count, truncated }`. When `truncated` is true, show "Showing first N" with N = `records.length`.
- `fieldValue(record, name)`, `fieldLabel(record, name)`, `countBy(records, name, field?)`, `sumBy(records, name, valueOf?)` and `formatNumber(n, prefix)` read and summarize the results. `countBy` groups empty values under `key: ''`. Filter that group out, or give it a label.
- Every record value or label you put into markup goes through `escapeHtml(value)`, including option names, owner names and text fields. `this.outputUI` sanitizes scripts, but it keeps images, links, forms and styles, and the block renders for every viewer. `escapeHtml` is the only escaping helper; never write your own.
- Never hand-build filter or search JSON when a helper exists. Every helper throws a readable `Error`, so wrap the fetch in `try` and render the error state from `design.md`.

Count Contacts by a dropdown field named `status` for the current dashboard filters. Use a field name from `getFields`:

```js
import {
  blockFilters,
  countBy,
  escapeHtml,
  getFields,
  searchRecords,
} from '../../lib/kizenData.js';

try {
  const fields = await getFields(this, 'client_client');
  const { filters, unapplied } = blockFilters(this.args, fields);
  const search = { object: 'client_client', fieldNames: ['status'], filters };
  const { records, count, truncated } = await searchRecords(this, search);
  const rows = countBy(records, 'status').filter((row) => row.key !== '');
  const items = rows.map((row) => `<li>${escapeHtml(row.label)}: ${row.count}</li>`).join('');
  const note = truncated ? `Showing first ${records.length} of ${count}. ` : '';
  const team = unapplied.includes('teamFilter') ? '(team filter not applied)' : '';
  this.outputUI(`<ul>${items}</ul><p>${note}${team}</p>`);
} catch {
  this.outputUI('<div class="kz-state kz-state--error">Couldn\'t load data.</div>');
}
```

## Design

Before writing any markup or styles, read `design.md` in this skill directory and follow it exactly.

## The loop

Run these exact commands. The flags and JSON keys are the contract. `<api_name>` is the block's `config.json` `api_name`. `block targets` and `block push` both accept `-c/--credentials <path>` and `--profile <name>` to pick the credential.

1. **Validate.** Run `appbuilder block export <api_name>`. Fix every validation error it prints, then run it again until it passes.
2. **Choose the target with the user (first publish only).**
   - `appbuilder block targets --json` returns `{ surfaces: { dashboard: [...], homepage: [...] }, customObjects: [{ id, objectName, fetchUrl }] }`. Contacts appears in `customObjects` when available.
   - `appbuilder block targets --object <id> --json` returns `{ surfaces: { chart_group: [...] } }` for that object.
   - Only offer rows where `canEdit !== false`. Ask the user which surface and which specific one. Don't pick for them.
   - Optionally run `appbuilder block push <api_name> --dashboard <id> --json` to get a `needs_choice` result listing the existing custom blocks and "new".
3. **Preview.** Run `appbuilder block push <api_name> --dashboard <id> [--dashlet <id> | --create] --dry-run --json`. Show the user the `environment`, `businessId`, `dashboard.name`, `action` and any `warnings`.
4. **Apply** once the user agrees: run the same command with `--yes` in place of `--dry-run`. Treat the push as done only when `applied === true`. Give the user the returned `url`, then refresh the browser (below).
5. **Change requests.** Edit the files, validate again (step 1), then run `appbuilder block push <api_name> --yes --json`. With no target flags it updates the remembered dashlet. Refresh the browser (below) after each push. Repeat for each change.

A headless run without `--yes` is always a dry run.

### Refresh the browser after a push

Do this after every applied push, only when Claude-in-Chrome tools are available. Dashlets don't poll, so the user's open tab keeps the old block until it's refreshed. Don't reload the page.

1. List the open tabs (`tabs_context_mcp`) and find the one whose URL has the same origin and path as the result's `url`.
2. If there is no such tab, open `url` in a new tab (`tabs_create_mcp`) and go to step 5.
3. If the result has a `refresh` field, run `refresh.script` exactly as given in that tab with the page JavaScript tool (`javascript_tool`). If it has no `refresh` field, navigate that tab to `url` (`navigate`) and go to step 5.
4. Check what the script returned:
   - `{ refreshed: true, ... }`: the dashboard refetched in place.
   - `undefined`: the refresh hook isn't available on this page (an older Kizen build, or a page without the hook). Navigate the tab to `url` instead.
5. Wait a couple of seconds, take a screenshot (`computer`), and check that the block rendered: not blank, and no visible error. Report what you saw to the user. If the block is blank or shows an error, read the console and fix the block before pushing again.

Never run any other injected code in the user's tabs. `refresh.script` is the only script you may run.

### JSON results

- Dry run: `{ ok: true, applied: false, dryRun: true, action: 'create' | 'update', environment, businessId, dashboard: { id, name, type }, dashletId | null, url, method, path, body, warnings }`.
- Applied: `{ ok: true, applied: true, dryRun: false, action: 'created' | 'updated', ..., dashletId, url, refresh?: { dashboardId, script }, remembered }`. `refresh` is absent when the dashboard id isn't a uuid.
- If a `block push` result's `warnings` contains `Claude files managed by appbuilder are out of date; run appbuilder setup-claude`, run `appbuilder setup-claude`, re-read `.claude/skills/kizen-custom-block/SKILL.md`, then continue.
- Error: `{ ok: false, code, message, choice?, choices? }`. `code` is one of `needs_choice`, `validation_failed`, `invalid_block`, `auth_failed`, `forbidden`, `remembered_target_missing`, `drift_detected`, `network_error`, `credentials_invalid`, `production_requires_flag`, `not_found`, `usage_error`, `api_error` or `local_error`.

### `needs_choice`

`choice` is `'profile'`, `'block'`, `'dashboard'` or `'target'`. `choices` is a list of `{ value, label, args, surface?, canEdit?, pushKey?, isFromThisPlugin? }`, where `args` is a string array. Ask the user using each option's `label`, then re-run the same command with the chosen option's `args` appended exactly. Never construct these flags by hand. The "new" option is `{ value: 'new', args: ['--dashboard', <id>, '--create'] }`.

## Guardrails

- Never pass `--allow-production` unless the user explicitly asked, in this conversation, to publish to production (`go` or `fmo`).
- On `drift_detected`, stop and ask the user. Someone edited the block in Kizen since your last push, and `--force` overwrites their changes. Pass `--force` only when the user says to discard them.
- On `needs_choice`, ask the user using the returned `choices` as described above. Never guess.
- On `remembered_target_missing`, the remembered dashboard or dashlet is gone. Ask the user where to publish instead, then push with `--dashboard <id>` plus `--create` or a `--dashlet` choice, or use `--forget` to clear the memory. `--create` alone won't work.
- On `credentials_invalid`, tell the user to fix the credential file named in `message`, or to pass `--profile` or `-c`.
- On `production_requires_flag`, the target is `go` or `fmo`. Apply the production rule above.
- Never push to a new target without first showing the user a dry run.
- Blocks run with the viewing user's permissions for every viewer. Don't write code that creates, updates or deletes data unless the user asked for it.
