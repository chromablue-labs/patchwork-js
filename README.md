# patchwork-js

The JavaScript SDKs for [Patchwork](https://usepatchwork.co).

| Package | What it is |
| --- | --- |
| [`@usepatchwork/client`](packages/client) | The framework-agnostic API client: threads, runs, realtime and voice |
| [`@usepatchwork/react`](packages/react) | Headless React SDK. Brings your own UI |
| [`@usepatchwork/audio`](packages/audio) | Browser audio engine for voice UX |

Documentation is at [docs.usepatchwork.co](https://docs.usepatchwork.co).

## Working on these

```bash
bun install
bun run check     # build, then typecheck, then test
```

`@usepatchwork/react` imports types from the built output of `client` and `audio`, so `build` runs first and in dependency order. A single package:

```bash
bun run --filter '@usepatchwork/client' test
```

The audio browser suite needs Chromium and runs on its own:

```bash
cd packages/audio && bun run test:browser
```
