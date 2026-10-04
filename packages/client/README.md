# @usepatchwork/client

The framework-agnostic client for the [Patchwork](https://usepatchwork.co) API. Threads, runs, realtime and voice, with no UI framework attached.

```bash
bun add @usepatchwork/client
```

If you are building with React, install [`@usepatchwork/react`](https://www.npmjs.com/package/@usepatchwork/react) instead — it wraps this package in hooks and depends on it, so you get both.

## What this package is for

Driving an agent from the browser, as the signed-in user. It holds a short-lived **session token** your own backend mints, and never a workspace API key.

```ts
import { PatchworkClient } from "@usepatchwork/client";

const client = new PatchworkClient({
  url: "https://api.usepatchwork.co",
  agent: "agent_...",
  mint: async () => {
    const response = await fetch("/patchwork/mint", { method: "POST" });
    const { token } = await response.json();
    return token;
  },
});

const thread = await client.createThread();
const run = await client.sendMessage(thread.id, "What did we ship last week?");
```

`mint` is called when the client needs a token and again shortly before the one it holds expires. It is the only place a credential enters the client: the token lives in memory, and nothing writes it to `localStorage`, a cookie or a URL.

## Never put an API key here

A workspace API key is not a user credential. In relay mode it chooses the subject, so it can act as **any** subject in the workspace — it is a tenant-wide credential, and a browser bundle is not where it belongs. Mint a session token on your server and hand this client that instead.

Server-side code that legitimately holds an API key belongs in a server package, not this one.

## Pagination

List calls follow the API's cursor pagination. `getMessages` walks the pages for you and returns a whole conversation oldest-to-newest; `listThreads` takes a page size.

## Realtime

`Realtime` subscribes to a thread's channel and streams the run's events. Patchwork authorises each subscription against the token's subject, so a client cannot subscribe to a thread its subject does not own.

## Compatibility

One runtime dependency: `pusher-js`. Works in any browser bundler, and in any framework — the React hooks live in `@usepatchwork/react`.

## Licence

MIT.
