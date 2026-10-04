# @usepatchwork/react

Headless React SDK for embedding [Patchwork](https://usepatchwork.co) agents. You bring the UI; the SDK handles auth, threads, and resume.

```bash
bun add @usepatchwork/react
```

## Setup

Wrap your app in a provider. You supply a `mint` function that returns a short-lived token from your own backend — the SDK never sees how you authenticate your users.

```tsx
import { PatchworkProvider } from "@usepatchwork/react";

<PatchworkProvider
  url="https://api.usepatchwork.co"
  mint={async () => {
    const res = await fetch("/patchwork/mint", { method: "POST" });
    const { data } = await res.json();
    return data.token;
  }}
>
  <App />
</PatchworkProvider>;
```

## Use

`useAgent` hands you the conversation state and the actions. You render.

```tsx
import { useAgent } from "@usepatchwork/react";

function Chat() {
  const { messages, threads, status, send, openThread, newChat } = useAgent();

  return (
    <div>
      <button onClick={newChat}>New chat</button>
      <ul>
        {threads.map((thread) => (
          <li key={thread.id} onClick={() => openThread(thread.id)}>
            {thread.title}
          </li>
        ))}
      </ul>

      {messages.map((message) => (
        <div key={message.id}>{message.content}</div>
      ))}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.namedItem("q") as HTMLInputElement;
          send(input.value);
          input.value = "";
        }}
      >
        <input name="q" disabled={status === "sending"} />
      </form>
    </div>
  );
}
```

The current thread is remembered across reloads and resumed automatically. Threads are created lazily on the first message.

## Hooks

```tsx
useAgent({
  onMessage: (message) => {},
  onRunComplete: (run) => {},
  onError: (error) => {},
});
```
