---
applyTo: "src/**/*.js,kizen.json"
---

# Security review rules for plugin scripts

The rules themselves live in the docs corpus that
`.github/workflows/copilot-code-review.yml` fetches into `.copilot-docs/`, so
they cannot drift out of date here. Read them there rather than reviewing from
memory.

When a change touches a service, `auth_credentials`, a `{{secret.KEY}}`
reference, `base_config.secrets`, or dynamic code (`eval`, `new Function`, or a
string argument to `setTimeout` or `setInterval`), read
`.copilot-docs/06-auth-secrets-services.md` together with the "Services, auth &
secrets" and "Release & publish" sections of `.copilot-docs/17-gotchas.md`, and
review the change against what they say.

When a change uses `__dangerouslySkipProxy`, also read
`.copilot-docs/11-output-ui-iframes-frames.md`.
