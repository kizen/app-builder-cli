---
name: kizen-business-apps
description: Publish, preview, merge, roll back or pull this plugin as a Kizen Business App with `appbuilder app` (versions, push, publish, merge, rollback, pull, actions, preview). Use it when the user wants to release this plugin to their Kizen business, save, update or delete their preview, publish a new Live version, resolve a publish conflict or merge someone else's Live changes, restore an earlier release, download a released version's or their preview's source, or link the app's JS actions to objects.
---

# Kizen Business Apps

`appbuilder app` publishes the plugin in this folder as a Business App on the business the user is signed in to. Publishing replaces Live for everyone in that business, so every write is a dry run first. Follow these rules exactly.

## Before you start

- Run every command from the plugin folder (the one with `kizen.json`), with `--json`.
- If `appbuilder app` is an unknown command, the CLI is too old. Ask the user to upgrade `@kizenapps/cli` to 1.18.0 or later, then continue.
- If a result's `warnings` contains `{{STALE_WARNING}}`, run `{{SETUP_COMMAND}}`, re-read `{{SKILLS_DIR}}/kizen-business-apps/SKILL.md`, and follow the new copy.
- Never edit, delete or commit anything in `.kizenapp/`. `.kizenapp/apps.json` records what this folder is based on; push and merge depend on it. Your preview's base isn't in it: it lives only in the preview's source on the server (see "Another machine or folder"), so publishing works from any machine.
- The server numbers releases. `kizen.json` `version` isn't sent, so don't bump it for an app release.

## The contract

- `--json` prints one JSON object on stdout. Human text goes to stderr. Parse stdout only.
- Exit `0`: success, dry runs included. Exit `2`: a decision is needed (`needs_choice` or `base_required`); its `choices` say how to go on. Exit `1`: any other failure, `{ ok: false, code, message, hint? }`.
- Every `argv` you get (`choices[].argv`, `next[].argv`, `applyArgv`, `login.argv`, and a JS action's `linkArgv`, `linkMenuArgv`, `linkNoMenuArgv` and `unlinkArgv`) is a whole command starting with `appbuilder`. Run it exactly as given. Never add, drop or reorder its flags, and never build these commands yourself. The only edit you may make to any argv is replacing an element that is exactly `<object>` (in `linkArgv`, `linkMenuArgv` and `linkNoMenuArgv`) with an object's api name or id. They carry the account the run used (`--env`, `--business`, `--user`, or its `-c`/`--profile`), so they act on the same business.
- `push`, `publish`, `merge`, `rollback` and `preview delete` without `--yes` are dry runs: `{ ok: true, applied: false, dryRun: true, …, applyArgv, requiresProductionConsent, next: [] }`. `applyArgv` is that command with `--yes` (and `--allow-production` on `go` or `fmo`). It is pinned to what the dry run showed: `publish` to the preview it reviewed (`--expect-preview <id>`), `merge` to the version it planned (`--release <n>`), `rollback` to its version, `preview delete` to the preview's owner (`--owner <userId>`, yours included) and the preview it reviewed (`--expect-updated <ts>`), with `--delete-app` only when it warned that the app goes too. A `push` apply uploads the folder as it is when the apply runs.
- `requiresProductionConsent: true` means the target is production (`go` or `fmo`). Show the user the dry run and get their explicit go-ahead in this conversation before running `applyArgv`.
- Applied results have `applied: true` and `next`: the commands to run next, in order, each `{ step, argv }`. After a merge with conflicts, `next` starts with `{ step: "resolve", files, markers }`.
- An applied publish whose `warnings` say "this folder's base wasn't advanced" did publish, but this folder still counts as based on the old Live. The next publish from it stops with `publish_conflict`; run the merge it offers, then push and publish.

## Workflow

1. **Look.** `appbuilder app versions --json` returns `live`, `released`, `previews`, `yourPreview`, `base` and `next`. `published: false` means the app isn't on this business yet; the first push and publish create it.
2. **Push your preview.** `appbuilder app push --json` is a dry run. Show the user `environment`, `businessId`, `app`, `source.files`, `base` and `warnings`. When they agree, run `applyArgv`. A push saves only the user's own preview; Live doesn't change.
3. **Link its JS actions.** Read the applied push's `jsActions` and link every action that needs it, `unlinked` and `unknown` alike (see "JS actions" below), before you move on.
4. **Publish.** Run the applied push's `next` step `publish` (`appbuilder app publish --json`), a dry run. Show the user `app`, `conflictCheck`, `nextReleaseAtLeast` and `warnings`. When they agree, run `applyArgv`. It's done when `applied` is `true`; tell the user the new `liveVersion`, then check its `jsActions` again.
5. **Every change after that:** edit, push (dry run, then `applyArgv`), link new JS actions, publish (dry run, then `applyArgv`).

### Live moved: `publish_conflict`

Someone published since your preview's base, and publishing now would overwrite their changes. Never answer with `--force`.

1. Run `next[0].argv` (`appbuilder app merge …`), a dry run. Show the user `written`, `deleted`, `conflicted` and any other lists, then run `applyArgv` when they agree. A merge changes only local files.
2. If the applied merge's `next` starts with a `resolve` step, edit every file in its `files`. The side between `<<<<<<< HEAD` and `=======` is this folder's; the side between `=======` and `>>>>>>> live` is Live's (or the merged `--release`). Keep both sides' intended changes and delete the three marker lines. `appbuilder app push` refuses with `unresolved_conflicts` (listing `files`) until no markers are left.
3. Then follow the rest of `next`: push (dry run, `applyArgv`), publish (dry run, `applyArgv`).

### No recorded base: `base_required` (exit 2)

This happens when Live exists, the folder matches neither your preview nor a released version exactly (an exact match is detected and used automatically: `base.source` is `"preview"` or `"detected"`), and no usable base is recorded for it. That's the first push from a fresh clone, another machine or another developer's folder, or a push whose recorded base no longer applies (that version was deleted, or the app was deleted and created again; a notice in the `message` says which). Show the user the `message` and each choice's `label`:

- "Preview merging Live vN into this folder" is a dry run. You may run it without asking. With no base to merge from, it always comes back with `kind: "fallback"`, whose `choices` are "Merge, if this folder was copied from vM" (`--base <M>`) for recent releases, and "This folder already contains vN".
- "This folder already contains Live vN" records the base without merging (`--accept-live-base`). Run it only when the user confirms the folder really contains that version, or the next publish drops Live's changes.
- "This folder continues your preview (based on vN)" (`appbuilder app push --base-from-preview <id>`) is a push dry run that gives this folder your preview's base. Never run it on your own judgment: ask the user whether this folder really is the work they pushed as that preview (for example, carried on from another machine). Run it only when they say yes; a wrong yes lets the next publish overwrite Live's changes. Then show its dry run and run its `applyArgv` as for any push. If the user isn't sure, use the merge preview instead.

After the fallback, ask the user which release this folder was copied from:

- They know it: run that release's `--base <M>` choice. It merges for real; continue as after any merge (resolve markers, push, publish). A wrong base drops the changes made since then, so never guess one.
- They don't know: run the fallback's `applyArgv`. It extracts Live's source into `.kizenapp/live-v<N>-<time>/` (reported as `extracted.dir`) and changes nothing else. Help the user merge Live's changes into this folder by hand, then run the "This folder already contains vN" choice, and push.

### Another machine or folder

Every push and rollback stores the preview's base inside the preview's source on the server, and publish reads it from there. So:

- Publishing a preview the user pushed from another machine or folder needs no merge and no `--force`, unless Live moved since (then it's the usual `publish_conflict`).
- A push from a folder with nothing recorded takes the preview's base by itself when the folder's files equal the preview's (`base.source: "preview"`); otherwise `base_required` offers "This folder continues your preview", which only the user may choose.
- `conflict.reason: "base_replaced"` (a `publish_conflict`) means the version your preview was based on has been replaced on the business (the app was deleted and created again). Handle it like any `publish_conflict`: run `next[0].argv`, the merge dry run.
- `conflict.reason: "base_unknown"` (a `publish_conflict`) means the preview's source doesn't say what it's based on. Run `next[0].argv`, a push dry run of this folder; with the user's go-ahead, its `applyArgv`, then publish again.
- A preview pushed from this folder and published outside the CLI (in Kizen, say) is recognised: the folder's base becomes that Live version, with a notice; don't merge because of the old base.

### Roll back and pull

- `appbuilder app rollback <n> --json` restores released version n as the user's preview (dry run, then `applyArgv`). Its `next` is the publish dry run that makes it Live.
- `appbuilder app pull <n> --json` downloads release n into a new folder, `../<api_name>-v<n>` or `--out <dir>`, and records n as that folder's base. It never writes into an existing folder and needs no `--yes`. Continue in the folder it reports as `dir`.
- `appbuilder app pull --preview --json` does the same with the user's own preview, into `../<api_name>-preview` or `--out <dir>`. Pass `<n>` or `--preview`, never both. The result has `source: "preview"`, `preview` and `base` instead of `version`. `base.recorded: true` means the folder's base is the preview's base, so you can push and publish from it as usual; `false` (with a warning) means the preview doesn't say what it's based on, and the first push from the folder may stop with `base_required`. `no_preview` means the user has no preview to pull.

### Delete a preview

Only when the user asks to delete a preview:

1. Run `appbuilder app preview delete --json`, a dry run for the user's own preview. For another developer's preview, add `--owner <userId>` with the user id from `previews[].previewOwner.id` in `appbuilder app versions --json`, and only when the user explicitly named that developer's preview.
2. Show the user `owner`, `preview` and every `warnings` entry. They say when the preview is the app's only version (deleting it deletes the whole app from the business, settings and secrets included), when it belongs to someone else, and when other users are using it.
3. When the user agrees to every warning, run `applyArgv`. Never add `--delete-app` yourself; `applyArgv` carries it only when the dry run warned that the app goes too. A dry run with no `applyArgv` can't be applied: relay its `notices` to the user. The result has `status: "deleted"` and `appDeleted` (`true` when the app went with it). After deleting their own preview, its `next` is a push dry run, which makes a new preview.

`preview_changed` means the preview was pushed again after the dry run, or deleting it would now delete the whole app when the dry run said it stays: nothing was deleted. Run `next[0].argv`, a new dry run, and show it to the user again.

### JS actions: link them to objects

A JS action template does nothing until it's linked to an object. Always create these links with the CLI, even though the app's setup assistant may have a step for it. `push`, `publish` and `versions` results carry `jsActions`: `{ status, liveVersion, actions, next }`; `appbuilder app actions list --json` returns the same `actions`. Each action is `{ apiName, name, hintObjectName, status, inLive, links, linkArgv, linkMenuArgv, linkNoMenuArgv }`:

- `linked`: it has at least one link (`links[]`, each with the object's `objectName`, `includePerformAction` (the Perform Action menu setting) and `unlinkArgv`). Nothing to do.
- `unlinked`: in Live (or the app isn't on the business yet) with no link. Link it.
- `unknown`: only in a preview, so its links can't be listed, and it may not be linked yet. Link it right after the push, like an `unlinked` one.

How to link:

1. Pick the object with the user. For an `unlinked` action with a hint object, `jsActions.next` has a `link` step naming `hintObjectName`: it only suggests that object. Confirm it with the user, or ask which object (no hint, an `unknown` action, or the user wants another one). Don't run the `link` step itself; step 2's argv makes the one dry run.
2. Ask whether the action should show in the object's Perform Action menus. Take the action's `linkMenuArgv` if it should, and its `linkNoMenuArgv` if it shouldn't (for a link that exists, that turns the menu off); `linkArgv` leaves a new link off the menus and an existing one as it is. Replace the one element that is exactly `<object>` with the object's api name (like `client_client`) or id, change nothing else, and run it: a dry run of `appbuilder app actions link …`. Contacts counts as an object. Exit 2 with `choice: "object"` means several objects match: show the user the `choices` and run the one they pick.
3. Show the user the dry run (`environment`, `businessId`, `jsAction`, `object`, `change`, `includePerformAction`, `warnings`). When they agree, run `applyArgv`. `status` is `created`, `updated`, `up_to_date` or `already_linked` (the link already existed and its menu setting wasn't changed: for an action only in a preview, linked before while its links couldn't be listed; for an action in Live, linked after this command listed the links, in which case run `appbuilder app actions list` and link it again to set the menu setting the user wants).
4. Review with `appbuilder app actions list --json`: every action with its `status`, `links` and argvs, and link dry runs in `next`. It lists the links of Live's actions only; a preview-only action stays `unknown` until it's published.

If a link of an `unknown` action fails with `api_error` and a `hint` saying Kizen couldn't find it, that Kizen environment can only link actions in Live. Relay the hint: publish first, then link it.

A link change to an action in Live (`inLive: true`), whether a new link, a menu setting or an unlink, reaches everyone using Live as soon as it's applied; its dry run's `warnings` say so. Treat it like a publish: confirm the object and the menu setting with the user before running its `applyArgv`.

Remove a link only when the user asks: run that link's `unlinkArgv` (`appbuilder app actions unlink …`, a dry run), then its `applyArgv` when they agree.

### What a push uploads

Git's file list (tracked files, plus untracked ones `.gitignore` doesn't exclude; outside git, everything minus the root `.gitignore`), minus the root `.kizenignore` (gitignore syntax; it can only exclude more). These are never uploaded, whatever either file says: `node_modules`, `.git`, `.kizenapp`, `.kizenappbuilder`, `.copilot-docs`, `__pycache__`, `dist`, `.DS_Store`, `.env`, `.env.*`, `.npmrc`, `credentials.json`, and the skill folders appbuilder manages (`kizen-custom-block` and `kizen-business-apps` under `.claude/skills/` and `.agents/skills/`). Other skills in those folders are uploaded like any file. Check `source.files` in the dry run, and suggest a `.kizenignore` entry for anything that shouldn't ship. A release needs a thumbnail.

## Failures

| `code` | What to do |
| --- | --- |
| `not_signed_in` | Ask the user to sign in by running `login.argv` themselves: it opens a browser (see Sandboxes). Then run your command again. |
| `needs_choice` | `choice` is `environment`: the user is signed in to several. Ask which, then run that choice's `argv`. |
| `base_required` | See "No recorded base" above. |
| `publish_conflict` | Run `next[0].argv`: a merge dry run; a push dry run when `conflict.reason` is `base_unknown`; or, when your preview changed since the dry run, a new publish dry run. |
| `unresolved_conflicts` | Resolve the markers in `files`, then push again. |
| `no_preview` | Push first. For `pull --preview`, the user has no preview: tell them, or pull a release instead. |
| `preview_changed` | Nothing was deleted. Run `next[0].argv`, a new `preview delete` dry run, and show it to the user before going on. |
| `preview_incomplete` | Push again, then publish (or pull). |
| `thumbnail_required` | Add a thumbnail to the plugin, push, then publish. |
| `source_invalid` | The folder can't be zipped (no `kizen.json`, an unreadable `.kizenignore`, a folder git ignores, or a file over 50 MiB or 200 MiB in all). Fix what `message` says, for example with a `.kizenignore` entry. |
| `validation_failed` | Fix every item in `issues`, then run the command again. |
| `forbidden` | Tell the user they need the Marketplace › Business App Developer permission at the Delete/All level. Don't retry. |
| `production_requires_flag` | You ran a write against `go` or `fmo` without `--allow-production`. Run the dry run, get consent, then its `applyArgv`. |
| `credentials_invalid` | The API-key file from `-c` or `--profile` is bad. Tell the user what `message` says. Use API keys only when the user asks. |
| `auth_failed` | Kizen refused the session. Ask the user to sign in again (`appbuilder login`, with `--env <env>` for an environment other than `go`). |
| `session_store_unwritable`, `network_error` | Usually a sandbox; see below. Otherwise relay `message` and `hint`. |
| `not_found`, `usage_error`, `api_error`, `local_error` | Relay `message` to the user. |

## Sandboxes

`appbuilder` needs the network and write access to `~/.kizenappbuilder`, where it keeps the sign-in session and refreshes its tokens. It talks to the Kizen environment's hosts, and `push` uploads go to whichever file-storage host Kizen names for each upload.

{{#codex}}
- Codex's sandbox turns the network off and allows writes only to the workspace and `/tmp`. Run `appbuilder` commands with `sandbox_permissions: "require_escalated"`, and suggest `prefix_rule: ["appbuilder"]` so the user approves `appbuilder` once. A `network_error` with `sandbox: "codex_network_disabled"`, or a `session_store_unwritable`, means it ran without that.
- `.agents/` is read-only in the sandbox, so `appbuilder setup-codex` needs the escalation too.
- `appbuilder app pull` writes next to the plugin folder by default, outside the workspace. Escalate it, or pass an `--out <dir>` inside the workspace that `.gitignore` or `.kizenignore` excludes.
- `not_signed_in`: the user runs `login.argv` in their own terminal. It opens a browser and waits for the sign-in.
{{/codex}}
{{#claude}}
- Claude Code's sandbox, when enabled, allows writes only to the working directory and the network only to allowed domains. Because uploads go to a storage host Kizen picks, a domain list can't cover `appbuilder`. If it fails with `session_store_unwritable` or a `network_error`, ask the user to add `"appbuilder *"` to `sandbox.excludedCommands` in their user settings (`~/.claude/settings.json`), so `appbuilder` runs outside the sandbox. Project settings don't work for this when Claude Code runs in strict mode.
- `not_signed_in`: the user types `! ` followed by the `login.argv` command in this session, or runs it in their own terminal. It opens a browser and waits for the sign-in.
{{/claude}}

## Guardrails

- Never pass `--force`, `--allow-production` or `--accept-live-base`, or run a choice whose `argv` contains one, unless the user explicitly asked for it in this conversation.
- Always show the user a dry run before you run its `applyArgv`.
- On exit 2, show the user the `choices` and run the one they pick. The merge preview is the only choice you may run without asking. Never pick "This folder continues your preview" for the user.
- Never edit `.kizenapp/`.
- Publish only when the user asked to publish.
- Link a JS action only to an object the user confirmed, and unlink only when the user asked.
- Delete a preview only when the user asked, and another developer's (`--owner`) only when the user named it.
