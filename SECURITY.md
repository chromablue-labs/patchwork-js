# Security policy

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/chromablue-labs/patchwork-js/security/advisories/new). Do not open a public issue.

Include the package, its version, the runtime, and the smallest code that demonstrates the problem. Redact API keys and session tokens.

## Supported versions

The latest release of each package. Fixes ship as a new version.

## In scope

- A session token, API key or any other credential reaching a place it should not: a log, an error message, `localStorage`, a URL, or an outbound request to anywhere but the configured Patchwork host
- `@usepatchwork/client` sending a credential over a connection it was not configured with
- A realtime subscription delivering one subject's messages to another subject
- Rendering untrusted block content in a way that executes it

## Out of scope

- Putting a workspace API key in a browser. These packages are built for session tokens in the browser; an API key belongs on your server. See the authentication guide.
