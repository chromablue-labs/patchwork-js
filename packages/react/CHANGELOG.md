# Changelog

## 0.2.1

- `exports` now includes `./package.json`. Tooling that reads a dependency's manifest directly could not, because the export map did not list it.

## 0.2.0

First release. Headless React SDK for embedding Patchwork agents: auth, threads and resume, with the UI left to you.

The API client moved out to `@usepatchwork/client`, which this package now depends on. Everything that does not need React lives there, so a non-React app can use the client on its own. `BlockRenderer` and `RendererRegistry` stay here, since they are the only React-dependent types.
