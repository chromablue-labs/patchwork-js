# Changelog

## 0.2.0

First release. Headless React SDK for embedding Patchwork agents: auth, threads and resume, with the UI left to you.

The API client moved out to `@usepatchwork/client`, which this package now depends on. Everything that does not need React lives there, so a non-React app can use the client on its own. `BlockRenderer` and `RendererRegistry` stay here, since they are the only React-dependent types.
