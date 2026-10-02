# Copilot review instructions for this Kizen plugin

This repo is a Kizen plugin app: a `kizen.json` manifest plus the artifacts
that `@kizenapps/packager` finds by walking the directory tree under the
manifest's `entry` (default `src/`). No manifest key lists artifacts. The
directory layout decides what gets packaged.

## The full Kizen plugin documentation is available at `.copilot-docs/`

Before this review started, the complete Kizen plugin developer documentation
was fetched into `.copilot-docs/` by `.github/workflows/copilot-code-review.yml`.
It is not committed to this repo — it is cloned from `kizen/app-engine` at review
time, so it is always current. It is the authoritative reference for every plugin
API, manifest field and runtime contract. Deliberately, no plugin rules are
copied into this repo: read them from `.copilot-docs/` instead.

Use it. Start from:

- `.copilot-docs/17-gotchas.md` — the consolidated list of traps and silent
  failure modes, grouped by topic. Scan the sections relevant to the changed
  files.
- `.copilot-docs/method-index.md` — A–Z lookup from any method, manifest field,
  endpoint or identifier to the doc that owns it.
- `.copilot-docs/03-manifest-reference.md` — every `kizen.json` and `config.json`
  field, the component directory names, `api_name` rules, and the build/publish
  validation rules.
- The other numbered docs (`.copilot-docs/04-worker-runtime-api.md`,
  `.copilot-docs/07-automation-steps.md`, `.copilot-docs/08-actions.md`, and so
  on) for complete contracts.

**Many Kizen plugin APIs fail silently when misused** — the call succeeds,
nothing throws, and the behavior is quietly wrong. These defects are not
detectable from the calling code alone, and they are the single most valuable
thing to catch in review. When a changed file calls a `this.*` worker method,
look that method up in `method-index.md` and read its contract before concluding
the call is correct.

The same applies to artifact config: check each `config.json` against
`03-manifest-reference.md`, and each automation step against
`07-automation-steps.md`.

When a review comment is based on the documentation, name the file it came from.

If `.copilot-docs/` is not present, the setup workflow did not run — it only
takes effect once it is on the repository's default branch — so say that in
the review instead of guessing at the rules from memory.

## Scope

This file covers repo structure and general review. Two path-scoped files cover
the rest: `.github/instructions/security.instructions.md` for security-sensitive
patterns and `.github/instructions/version-discipline.instructions.md` for
manifest version bumps.
