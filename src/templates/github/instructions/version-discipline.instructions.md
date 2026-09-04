---
applyTo: "kizen.json"
---

# Version-bump discipline for `kizen.json`

## What a wrong bump breaks

A business that installs this plugin accumulates its own stored state
(automation runs, config values, references to entities) shaped by what was
published at the time. Publishing is additive: it never rewrites a business's
stored rows, and the plugin author has no way to migrate that state for them.
A change is breaking when it invalidates an assumption the business's existing
data already depends on.

A MINOR or PATCH republish applies at once to a business's running automations
and installed artifacts. Only a new MAJOR version waits for the business to
upgrade explicitly. A change that needed MAJOR but shipped as MINOR or PATCH
therefore breaks the business with no upgrade gate in between.

Two kinds of change get MAJOR because they fail without an error:

- Renaming a config field, changing its type, or adding a required key. A
  template reference like `{{config.key}}` for a key that no longer exists
  resolves to a literal `null`, and the artifact renders wrong or does
  nothing.
- Removing or renaming a JS action. A business's automation and UI
  associations key on the action's `api_name` as a plain string, with no
  foreign key. After a rename or removal those associations stop firing.

Review every `kizen.json` diff against the table below before approving the
version bump in the same PR.

## Bump matrix

| Resource | Change | Required bump |
| --- | --- | --- |
| Plugin | change `api_name` | **HARD-BLOCK**: identity can never change |
| Service | add | MINOR |
| Service | remove | MAJOR |
| Service | change auth type or `auth_level` | MAJOR |
| Service | change `auth_credentials` (client id/secret, scopes, authorize/token URLs) | MAJOR |
| Service | change base URL or other non-auth field | PATCH |
| Service | rename `api_name` | MAJOR |
| Secret | add | MINOR |
| Secret | remove | MINOR |
| Secret | rename key | MAJOR |
| Secret | re-encrypt value only | PATCH |
| Automation step | add | MINOR |
| Automation step | remove entire step | MAJOR |
| Automation step | remove an input or output | MAJOR |
| Automation step | change input/output `data_type` | MAJOR |
| Automation step | add required input | MAJOR |
| Automation step | add optional input | MINOR |
| Automation step | change python runtime | PATCH |
| Automation step | edit script body only | PATCH |
| Artifact (frame, block, adornment, page, route script, toolbar/object-settings item, calendar source) | add | MINOR |
| Artifact | remove | MINOR |
| Artifact | rename `api_name` | MINOR |
| Artifact | edit script or behavior | PATCH |
| JS action | add | MINOR |
| JS action | remove | MAJOR |
| JS action | rename `api_name` | MAJOR |
| JS action | change `hint_object_name` or script | PATCH |
| Config field | add optional (with default) | MINOR |
| Config field | add required (no default) | MAJOR |
| Config field | remove | MINOR |
| Config field | rename | MAJOR |
| Config field | change type | MAJOR |
| Config field | change default or label | PATCH |
| `required_entitlement` | add gating | MINOR |
| `required_entitlement` | change or remove | PATCH |
| Manifest metadata (`name`, `description`, `entry`, `release_branches`, `release_environments`, `published`, `developer_business_id`) | any change | PATCH |
