import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { PatchworkProvider } from "../src/provider";
import { useAgent, type UseAgent } from "../src/use-agent";

const URL_BASE = "https://api.example.test";
const STORAGE_KEY = "patchwork.thread";

let requested: string[] = [];
let handlers: Record<string, (body: string | undefined) => unknown> = {};
const realFetch = globalThis.fetch;

function jwt(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
}

function rawThread(id: string, title: string) {
  return {
    id,
    title,
    message_count: 1,
    plan: [],
    last_message: null,
    pending_elicitation: null,
    pending_action: null,
    pending_confirmation: null,
  };
}

function rawMessage(id: string, content: string) {
  return {
    id,
    role: "user",
    content,
    parts: [],
    run_id: "run_seed",
    seq: 1,
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  requested = [];
  localStorage.clear();
  handlers = {};
  globalThis.fetch = (async (input: unknown, init?: Record<string, unknown>) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    const key = `${method} ${url.replace(`${URL_BASE}/v1/loom`, "")}`;
    requested.push(key);

    const match = Object.keys(handlers)
      .sort((a, b) => b.length - a.length)
      .find((pattern) => key.startsWith(pattern));
    if (!match) {
      return new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });
    }
    const payload = handlers[match]!(init?.body as string | undefined);
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function mount() {
  const seen: { current: UseAgent | null } = { current: null };

  function Probe() {
    const agent = useAgent();
    useEffect(() => {
      seen.current = agent;
    });
    seen.current = agent;
    return null;
  }

  render(
    <PatchworkProvider url={URL_BASE} mint={async () => jwt()}>
      <Probe />
    </PatchworkProvider>,
  );

  return seen;
}

function twoThreads() {
  handlers["GET /threads"] = () => ({
    status: "success",
    data: [ rawThread("thr_first", "First"), rawThread("thr_second", "Second") ],
    pagination: { next_cursor: null, has_more: false, limit: 30 },
  });
  handlers["GET /realtime/config"] = () => ({ status: "success", data: { enabled: false } });
  handlers["GET /threads/thr_first/messages"] = () => ({
    status: "success",
    data: [ rawMessage("msg_1", "hello from first") ],
    pagination: { next_cursor: null, has_more: false, limit: 50 },
  });
  handlers["GET /threads/thr_second/messages"] = () => ({
    status: "success",
    data: [ rawMessage("msg_2", "hello from second") ],
    pagination: { next_cursor: null, has_more: false, limit: 50 },
  });
}

test("a stored thread id that the server did not list is ignored", async () => {
  localStorage.setItem(STORAGE_KEY, "thr_someone_elses");
  twoThreads();

  const agent = mount();
  await waitFor(() => expect(agent.current?.threadId).toBe("thr_first"));

  expect(requested.some((r) => r.includes("thr_someone_elses"))).toBe(false);
});

test("a hostile stored value never reaches a request path", async () => {
  localStorage.setItem(STORAGE_KEY, "../../v1/voice/voices");
  twoThreads();

  const agent = mount();
  await waitFor(() => expect(agent.current?.threadId).toBe("thr_first"));

  expect(requested.some((r) => r.includes(".."))).toBe(false);
  expect(requested.some((r) => r.includes("voice"))).toBe(false);
});

test("a stored id the server did list is resumed", async () => {
  localStorage.setItem(STORAGE_KEY, "thr_second");
  twoThreads();

  const agent = mount();
  await waitFor(() => expect(agent.current?.threadId).toBe("thr_second"));
  await waitFor(() => expect(agent.current?.messages).toHaveLength(1));

  expect(agent.current?.messages[0]?.content).toBe("hello from second");
});

test("with nothing stored the newest thread opens", async () => {
  twoThreads();

  const agent = mount();
  await waitFor(() => expect(agent.current?.threadId).toBe("thr_first"));
});

test("a failed send leaves the thread and its earlier messages intact", async () => {
  localStorage.setItem(STORAGE_KEY, "thr_second");
  twoThreads();
  handlers["POST /threads/thr_second/messages"] = () =>
    new Response(
      JSON.stringify({ status: "error", error: { message: "Insufficient credits", code: "insufficient_credits" } }),
      { status: 402, headers: { "content-type": "application/json" } },
    );

  const agent = mount();
  await waitFor(() => expect(agent.current?.threadId).toBe("thr_second"));
  await waitFor(() => expect(agent.current?.messages).toHaveLength(1));

  await act(async () => {
    await agent.current!.send("this will fail");
  });

  await waitFor(() => expect(agent.current?.error).not.toBeNull());
  expect(agent.current?.error?.code).toBe("insufficient_credits");
  expect(agent.current?.threadId).toBe("thr_second");
  expect(agent.current?.messages.some((m) => m.content === "hello from second")).toBe(true);
  expect(localStorage.getItem(STORAGE_KEY)).toBe("thr_second");
});

test("a failed send does not strand the hook in a sending state", async () => {
  localStorage.setItem(STORAGE_KEY, "thr_second");
  twoThreads();
  handlers["POST /threads/thr_second/messages"] = () =>
    new Response(JSON.stringify({ status: "error", error: { message: "nope", code: "bad_request" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

  const agent = mount();
  await waitFor(() => expect(agent.current?.threadId).toBe("thr_second"));

  await act(async () => {
    await agent.current!.send("this will fail");
  });

  await waitFor(() => expect(agent.current?.status).not.toBe("sending"));
});
