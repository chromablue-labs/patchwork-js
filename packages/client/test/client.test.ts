import { afterEach, beforeEach, expect, test } from "bun:test";
import { PatchworkClient, PatchworkError } from "../src/index";

const URL = "https://api.example.test";

function tokenWithExp(exp: number): string {
  const payload = btoa(JSON.stringify({ exp, sub: "usr_1:ws_1" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
}

function nowPlus(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: Call[] = [];
let respond: (call: Call) => { status?: number; payload: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  respond = () => ({ payload: { status: "success", data: {} } });
  globalThis.fetch = (async (input: unknown, init?: Record<string, unknown>) => {
    const call: Call = {
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(call);
    const { status = 200, payload } = respond(call);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function clientWith(mint: () => Promise<string>): PatchworkClient {
  return new PatchworkClient({ url: URL, mint });
}

test("mints once and reuses the token while it is still fresh", async () => {
  let mints = 0;
  const client = clientWith(async () => {
    mints += 1;
    return tokenWithExp(nowPlus(120));
  });

  respond = () => ({ payload: { status: "success", data: { id: "thr_1" } } });
  await client.createThread();
  await client.createThread();

  expect(mints).toBe(1);
  expect(calls).toHaveLength(2);
});

test("remints inside the refresh skew rather than sending a token about to expire", async () => {
  let mints = 0;
  const client = clientWith(async () => {
    mints += 1;
    return tokenWithExp(nowPlus(5));
  });

  respond = () => ({ payload: { status: "success", data: { id: "thr_1" } } });
  await client.createThread();
  await client.createThread();

  expect(mints).toBe(2);
});

test("a token with no readable expiry is treated as already expired", async () => {
  let mints = 0;
  const client = clientWith(async () => {
    mints += 1;
    return "not-a-jwt";
  });

  respond = () => ({ payload: { status: "success", data: { id: "thr_1" } } });
  await client.createThread();
  await client.createThread();

  expect(mints).toBe(2);
});

test("a mint rejection surfaces as an error instead of hanging", async () => {
  const client = clientWith(async () => {
    throw new Error("session expired");
  });

  await expect(client.createThread()).rejects.toThrow("session expired");
  expect(calls).toHaveLength(0);
});

test("the token travels in the Authorization header and never in the URL or body", async () => {
  const token = tokenWithExp(nowPlus(120));
  const client = clientWith(async () => token);

  respond = () => ({ payload: { status: "success", data: { run_id: "run_1", state: "running" } } });
  await client.sendMessage("thr_1", "hello");

  const call = calls[0]!;
  expect(call.headers.Authorization).toBe(`Bearer ${token}`);
  expect(call.url).not.toContain(token);
  expect(call.body ?? "").not.toContain(token);
});

test("the client never touches browser storage", async () => {
  const explode = () => {
    throw new Error("storage must not be touched");
  };
  const storage = new Proxy({}, { get: explode, set: explode });
  const globals = globalThis as Record<string, unknown>;
  globals.localStorage = storage;
  globals.sessionStorage = storage;

  try {
    const client = clientWith(async () => tokenWithExp(nowPlus(120)));
    respond = (call) => ({
      payload: { status: "success", data: call.method === "POST" ? { id: "thr_1" } : [] },
    });
    await client.createThread();
    await client.listThreads();
  } finally {
    delete globals.localStorage;
    delete globals.sessionStorage;
  }
});

test("an error envelope becomes a PatchworkError carrying the API's code", async () => {
  const client = clientWith(async () => tokenWithExp(nowPlus(120)));
  respond = () => ({
    status: 402,
    payload: { status: "error", error: { message: "Insufficient credits", code: "insufficient_credits" } },
  });

  try {
    await client.createThread();
    throw new Error("should have raised");
  } catch (error) {
    expect(error).toBeInstanceOf(PatchworkError);
    expect((error as PatchworkError).code).toBe("insufficient_credits");
    expect((error as PatchworkError).message).toBe("Insufficient credits");
  }
});

test("a non-JSON response is an error, not a crash", async () => {
  const client = clientWith(async () => tokenWithExp(nowPlus(120)));
  globalThis.fetch = (async () =>
    new Response("<html>502</html>", { status: 502 })) as typeof fetch;

  await expect(client.createThread()).rejects.toBeInstanceOf(PatchworkError);
});

test("getMessages walks every page and returns the conversation oldest first", async () => {
  const client = clientWith(async () => tokenWithExp(nowPlus(120)));
  const pages: Record<string, unknown> = {
    first: {
      status: "success",
      data: [ message("m3"), message("m4") ],
      pagination: { next_cursor: "cur_1", has_more: true, limit: 2 },
    },
    cur_1: {
      status: "success",
      data: [ message("m1"), message("m2") ],
      pagination: { next_cursor: null, has_more: false, limit: 2 },
    },
  };

  respond = (call) => {
    const cursor = new URLSearchParams(call.url.split("?")[1] ?? "").get("cursor");
    return { payload: pages[cursor ?? "first"] };
  };

  const messages = await client.getMessages("thr_1");

  expect(messages.map((m) => m.content)).toEqual([ "m1", "m2", "m3", "m4" ]);
  expect(calls).toHaveLength(2);
});

test("a list endpoint that answers with the wrong shape is an error, not a TypeError", async () => {
  const client = clientWith(async () => tokenWithExp(nowPlus(120)));
  respond = () => ({ payload: { status: "success", data: { not: "a list" } } });

  await expect(client.listThreads()).rejects.toBeInstanceOf(PatchworkError);
});

test("listThreads asks for a bounded page", async () => {
  const client = clientWith(async () => tokenWithExp(nowPlus(120)));
  respond = () => ({ payload: { status: "success", data: [] } });

  await client.listThreads();

  expect(calls[0]!.url).toContain("limit=30");
});

function message(content: string) {
  return {
    id: `msg_${content}`,
    role: "user",
    content,
    parts: [],
    run_id: "run_1",
    seq: 1,
    created_at: new Date().toISOString(),
  };
}
