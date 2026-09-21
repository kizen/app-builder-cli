---
applyTo: "kizen.json"
---

# Version-bump discipline for `kizen.json`

The bump matrix lives in the docs corpus that
`.github/workflows/copilot-code-review.yml` fetches into `.copilot-docs/`, so it
cannot drift out of date here.

Check every `kizen.json` diff against the "How big a bump?" matrix in
`.copilot-docs/16-release-and-publish.md` and the "Release & publish" section of
`.copilot-docs/17-gotchas.md`, and name the change that sets the required level.

Two things to hold the PR to:

- A version bump and its `releaseNotes/<version>.md` entry land in the same
  pull request.
- Changing the plugin's `api_name` is a hard block. Plugin identity can never
  change.
