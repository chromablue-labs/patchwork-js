# Changelog

## 0.1.1

- `exports` now includes `./package.json`. Tooling that reads a dependency's manifest directly could not, because the export map did not list it.

## 0.1.0

First release. The framework-agnostic client for the Patchwork API: threads, runs, realtime and voice, with no UI framework attached.

Built for a session token in the browser. A workspace API key belongs on your server.
