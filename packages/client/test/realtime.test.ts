import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const subscribed: string[] = [];
const unsubscribed: string[] = [];
let authorizer: ((params: { socketId: string; channelName: string }, cb: (e: Error | null, d: unknown) => void) => void) | null = null;

class FakeChannel {
  bound: string[] = [];
  bind(event: string, _handler: (payload: unknown) => void) {
    this.bound.push(event);
    return this;
  }
}

const channels = new Map<string, FakeChannel>();

mock.module("pusher-js", () => ({
  default: class FakePusher {
    constructor(_key: string, options: Record<string, any>) {
      authorizer = options.channelAuthorization?.customHandler ?? null;
    }
    subscribe(name: string) {
      subscribed.push(name);
      const channel = new FakeChannel();
      channels.set(name, channel);
      return channel;
    }
    unsubscribe(name: string) {
      unsubscribed.push(name);
    }
    disconnect() {}
  },
}));

const { Realtime } = await import("../src/realtime");
const { PatchworkError } = await import("../src/errors");

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://api.example.test",
    realtimeAuth: async () => ({ auth: "ok" }),
    ...overrides,
  } as any;
}

beforeEach(() => {
  subscribed.length = 0;
  unsubscribed.length = 0;
  channels.clear();
  authorizer = null;
});

afterEach(() => {
  mock.restore();
});

test("a thread subscription names exactly one channel, derived from the thread id", () => {
  const realtime = new Realtime("key", "eu", fakeClient());

  realtime.subscribeThread("thr_abc", () => {});

  expect(subscribed).toEqual([ "private-thread-thr_abc" ]);
});

test("subscribing to a second thread never widens the first subscription", () => {
  const realtime = new Realtime("key", "eu", fakeClient());

  realtime.subscribeThread("thr_one", () => {});
  realtime.subscribeThread("thr_two", () => {});

  expect(subscribed).toEqual([ "private-thread-thr_one", "private-thread-thr_two" ]);
  expect(subscribed.every((name) => name.startsWith("private-"))).toBe(true);
});

test("the channel is private, so Patchwork authorises every subscription", () => {
  const realtime = new Realtime("key", "eu", fakeClient());
  realtime.subscribeThread("thr_abc", () => {});

  expect(subscribed[0]!.startsWith("private-")).toBe(true);
  expect(authorizer).not.toBeNull();
});

test("authorisation asks the API about the channel it was handed, not one it invents", async () => {
  const seen: Array<{ socketId: string; channelName: string }> = [];
  const realtime = new Realtime(
    "key",
    "eu",
    fakeClient({
      realtimeAuth: async (socketId: string, channelName: string) => {
        seen.push({ socketId, channelName });
        return { auth: "signed" };
      },
    }),
  );
  realtime.subscribeThread("thr_abc", () => {});

  const result = await new Promise((resolve, reject) => {
    authorizer!({ socketId: "sock_1", channelName: "private-thread-thr_abc" }, (error, data) =>
      error ? reject(error) : resolve(data),
    );
  });

  expect(seen).toEqual([ { socketId: "sock_1", channelName: "private-thread-thr_abc" } ]);
  expect(result).toEqual({ auth: "signed" });
});

test("a refused authorisation is handed back as an error, not swallowed", async () => {
  const realtime = new Realtime(
    "key",
    "eu",
    fakeClient({
      realtimeAuth: async () => {
        throw new PatchworkError("Realtime authorization failed");
      },
    }),
  );
  realtime.subscribeThread("thr_abc", () => {});

  const error = await new Promise<Error | null>((resolve) => {
    authorizer!({ socketId: "sock_1", channelName: "private-thread-thr_abc" }, (e) => resolve(e));
  });

  expect(error).toBeInstanceOf(PatchworkError);
});
