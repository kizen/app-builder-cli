# Copilot review instructions for this Kizen plugin

This repo is a Kizen plugin app: a `kizen.json` manifest plus the artifacts
that `@kizenapps/packager` finds by walking the directory tree under the
manifest's `entry` (default `src/`). No manifest key lists artifacts. The
directory layout decides what gets packaged.

## Component directories

Under `entry`, the packager treats these directory names as component types:

- `floatingFrames`
- `blocks`
- `dataAdornments`
- `pages`
- `views`
- `toolbarItems`
- `objectSettingsItems`
- `actions`
- `routeScripts`
- `automationSteps`
- `calendarSources`

Every directory under a component type needs a `config.json`. `views/` is the
one exception.

## `api_name` rules

- An `api_name` must match `/^[a-z_][a-z0-9_]+$/`: lowercase letters, digits
  and underscores, starting with a letter or underscore, at least 2 characters.
- Set `api_name` explicitly in each artifact's `config.json`. The fallback
  lowercases and strips the directory name (`myFrame` becomes `myframe`), and
  that result can collide with another artifact's explicit `api_name`.
- Data adornments have no `api_name` field. Flag one that adds it as dead
  configuration.
- Sibling components in the same directory need unique `api_name`s. `pages/`
  and `views/` go further and share one namespace, so a page and a view with
  the same `api_name` collide even though they live in different directories.

## A green build does not mean a correct artifact

The packager coerces malformed artifact config instead of rejecting it: an
invalid `field_type` on a data adornment becomes `phonenumber`, and an invalid
`minimized_style` on a floating frame becomes `circle`. It also says nothing
about a missing required field. Publishing is the real gate. The publish step
creates each artifact with no defaulting, so a field the packager never emitted
is absent and the publish request 400s. Review each
`config.json` as if the build will not catch mistakes in it, because for these
cases it does not.

Publishing an app requires these fields per artifact type. An artifact missing
one builds clean and fails to publish:

| Artifact | Required fields |
| --- | --- |
| Floating frame | `api_name`, `name`, `title` |
| Block | `api_name`, `name` |
| Data adornment | `field_type` (one of `phonenumber`, `date`, `datetime`) |
| Routable page | `api_name`, `name` |
| Toolbar item | `api_name`, `label`, and a non-blank `script.js` |
| Object settings item | `api_name`, `label`, and a non-blank `script.js` |
| JS action | `api_name`, `name`, `hint_object_name` (non-blank) |

A floating frame whose `default_position` ends in `-fixed` must set
`minimized_style: "circle"` or omit `minimized_style`. Any other value fails
the build with `structure/fixed-frame-minimized-style`.

## Publishing

Publishing an app requires exactly one `thumbnail.png`, and it must sit inside
the `entry` directory (`src/thumbnail.png` by default). The packager never sees
a thumbnail at the repo root, and publishing then fails with "Thumbnail is
required for publishing".

## Scope

This file covers repo structure and general review. Two path-scoped files
cover the rest: `.github/instructions/security.instructions.md` for
security-sensitive patterns and
`.github/instructions/version-discipline.instructions.md` for manifest version
bumps.
