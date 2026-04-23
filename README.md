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

## License

GPL-3.0. See [LICENSE.md](./LICENSE.md).
