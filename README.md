# @kizenapps/cli

A local development environment for [Kizen](https://www.kizen.com) plugin apps.

`appbuilder` scaffolds a new plugin, bundles it, and runs a live viewer in a dedicated Chromium window so you can iterate on your plugin against any Kizen environment without having to publish, deploy, or reload by hand.

## Usage

Change directories to a directory containing plugin code, and run:

```sh
npx @kizenapps/cli dev
```

## Commands

### `@kizenapps/cli create`

Scaffolds a new plugin project. Interactive — prompts for the plugin name, API name, external link, description, and developer business ID, then writes a starter `kizen.json`, `src/`, and `releaseNotes/` into either the current directory or a subdirectory.

### `@kizenapps/cli build`

Reads the plugin in the current directory, minifies sources, and writes `.kizenapp/bundle.json`. No flags. Run this if you want to produce a bundle without starting the dev server.

### `@kizenapps/cli dev`

Starts the dev server and opens the viewer. Watches your plugin directory and rebuilds + hot-reloads the viewer on every change.

| Flag                       | Default | Purpose                                                          |
| -------------------------- | ------- | ---------------------------------------------------------------- |
| `-p, --port <port>`        | `3121`  | Port the local dev server listens on                             |
| `-c, --credentials <path>` | —       | Use a specific credentials JSON file instead of a stored profile |
| `-d, --debug`              | off     | Show a CDP event panel in the TUI                                |
| `-v, --verbose`            | off     | Log every CDP event (implies `--debug`)                          |

On first run you'll be prompted to set up credentials — either stored globally at `~/.kizenappbuilder/` or kept locally in your browser instance in `.kizenapp/`. Subsequent runs read from the stored profile silently. Press `c` in the TUI at any time to switch profiles.

Supported environments: `go`, `fmo`, `staging`, `integration`, `test1`.

## Navigation context

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

## License

GPL-3.0. See [LICENSE.md](./LICENSE.md).
