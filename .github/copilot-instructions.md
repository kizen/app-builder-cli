# Copilot review instructions for the Kizen app builder CLI

This repo is `@kizenapps/cli`, the `appbuilder` binary that scaffolds,
validates, builds and locally runs Kizen plugin apps. It contains no plugin
code. It is the tooling that implements the plugin contract: the manifests and
artifact configs it writes, the data types and runtimes it emulates, and the
commands its README tells plugin authors to run.

## The full Kizen plugin documentation is available at `.copilot-docs/`

Before this review started, the complete Kizen plugin developer documentation
was fetched into `.copilot-docs/` by `.github/workflows/copilot-code-review.yml`.
It is not committed to this repo — it is cloned from `kizen/app-engine` at
review time, so it is always current.

Here the docs are not rules for authoring a plugin. They are the contract this
CLI must conform to. When a change touches one of the surfaces below, read the
owning doc and flag the change if the CLI would accept, emit, document or
emulate something the docs do not describe, or if the docs describe something
the CLI no longer handles.

Start from `.copilot-docs/method-index.md`, the A–Z lookup from any method,
manifest field, endpoint or identifier to the doc that owns it, and
`.copilot-docs/17-gotchas.md`, the consolidated list of traps and silent
failure modes.

## CLI surface to owning doc

| CLI surface                                                                                                                                                                                                    | Owning doc                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `src/templates/artifacts/**`, `src/lib/createPlugin.ts`, `src/lib/createArtifacts.ts` — the scaffolded manifest and artifact configs                                                                           | `03-manifest-reference.md`                              |
| `viewer/src/remoteRunner.ts`, `src/server/pythonExecutor.ts`, `src/server/requestHandler.ts`, `src/server/python-requirements.txt` — automation step data types, wire type codes, runtimes, available packages | `07-automation-steps.md`                                |
| `viewer/src/**` setup-assistant rendering, `viewer/src/hooks/usePluginConfig.ts`                                                                                                                               | `13-setup-assistants.md`                                |
| Viewer sandbox navigation, `window.open` and message emulation — `viewer/src/pages/SandboxPage.tsx` and related                                                                                                | `14-navigation-and-communication.md`                    |
| `src/lib/encryptHeadless.ts`, `src/lib/encryptHelpers.ts`, `src/lib/encryptionClient.ts`, `viewer/src/pages/SecretsPage.tsx`                                                                                   | `06-auth-secrets-services.md`                           |
| `README.md` documentation of the `create`, `build`, `dev` and `encrypt` commands                                                                                                                               | `02-getting-started.md` and `16-release-and-publish.md` |

Those last two docs tell plugin authors which CLI commands and flags to run, so
drift in either direction is a finding: say which side is wrong, the README or
the doc.

The scaffold templates under `src/templates/github/` are what
`appbuilder create` and `appbuilder setup-copilot` write into plugin repos, and
by design they carry no plugin-authoring rules — only pointers to
`.copilot-docs/`. Flag any pull request that adds a rule, a field list, a type
list or a version matrix to those templates. That content belongs in the
`kizen/app-engine` docs.

If `.copilot-docs/` is not present, the setup workflow did not run — it only
takes effect once it is on the repository's default branch — so say that in the
review instead of reviewing the contract from memory.

When a review comment relies on the documentation, name the doc file it came
from.
