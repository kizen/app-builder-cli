---
applyTo: "src/**/*.js,kizen.json"
---

# Security review rules for plugin scripts

These rules mirror the `security/*` validation rules in `@kizenapps/packager`.
Flag violations the way the packager would, and also flag the patterns listed
here that its static scan cannot detect.

## `__dangerouslySkipProxy`

The packager lets `__dangerouslySkipProxy` through with the build WARNING
`security/dangerously-skip-proxy`. Flag every occurrence for human review
anyway, because the request leaves the browser directly instead of passing
through the Kizen proxy.

## Plaintext credentials

In `kizen.json`, a service's `auth_credentials.token`,
`auth_credentials.password` and `auth_credentials.client_secret` must each be
one of:

- an encrypted envelope (`{ "encrypted": true, "value": "..." }`) that
  `appbuilder encrypt` produced
- a `{{secret.KEY}}` reference, with `KEY` declared in `base_config.secrets`
- a reference through `auth_credentials.integration_secret_api_name`

A raw literal in any of those three fields is the build ERROR
`security/plaintext-credential`. Treat a credential that reaches a commit in
plaintext as compromised and rotate it; deleting the line does not undo the
exposure.

`client_id` is excluded from this rule on purpose. Public client ids are not
sensitive, so do not flag them.

## Undeclared secret references

A `{{secret.KEY}}` reference whose `KEY` is missing from `base_config.secrets`
is the build ERROR `security/undeclared-secret-reference`, because nothing
would supply the value at install time.

## Dynamic code execution

`eval(...)`, `new Function(...)` or `Function(...)`, and a string argument to
`setTimeout` or `setInterval` are the build ERROR `security/dynamic-code`.

This rule catches direct, literal usage only. The packager's scan is
parser-based, so a call built through a computed property or a reassigned
reference gets past it. Obfuscated dynamic code stays a human-review concern.

## Secret logging and exfiltration

The packager has no static check for a secret that gets logged, sent to an
unexpected endpoint, or otherwise exfiltrated. Review for this by hand: look
for credentials or decrypted secret values flowing into `console.log`, error
messages, analytics calls, or outbound requests to anything other than the
service they belong to.

## Handling secrets in this repo

Encrypt secrets locally with `appbuilder encrypt` before committing them. Do
not commit a plaintext secret value in any form; a comment, a script fixture,
and a commit you intend to rewrite later all count.
