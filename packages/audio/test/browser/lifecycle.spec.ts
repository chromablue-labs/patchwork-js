import { expect, test, type Page } from "@playwright/test";

/**
 * Slice 1 — lifecycle. Each test is named for the 0.1.0 finding it pins.
 * Chromium runs with a fake capture device and the REAL autoplay policy, so
 * anything that needs a gesture goes through `gesture()`, which clicks the
 * harness button (a trusted event) and evaluates `expr` inside the handler.
 */

async function gesture(page: Page, expr: string): Promise<unknown> {
  await page.evaluate((src) => {
    window.gesture = new Function(`return (${src})`) as () => unknown;
  }, expr);
  await page.click("#gesture");
  return page.evaluate(() => window.gestureResult);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    window.log = [];
    window.errors = [];
    window.E = window.A.createEngine();
    window.E.on("state", (s) => window.log.push(`state:${s}`));
    window.E.on("mic", (s) => window.log.push(`mic:${s}`));
    window.E.on("error", (e) => window.errors.push({ code: e.code, recoverable: e.recoverable, message: e.message }));
  });
});

test("state is derived from the context: locked → ready → interrupted → ready", async ({ browser }) => {
  // Not the shared `page`: the beforeEach has already evaluated on it, which grants
  // sticky activation. A pristine context, and no evaluate until the page-owned
  // scenario has finished (unlock() gives up after 250ms).
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/?scenario=locked");
  await page.waitForTimeout(700);

  const locked = await page.evaluate(() => window.locked);
  expect(locked).toEqual({
    activeBefore: false, // if this is ever true the harness is contaminated, and the test must fail loudly
    stateAtBirth: "locked",
    attempt: "not_unlocked", // did not hang on resume(), did not resolve
    stateAfter: "locked",
    activeAfter: false,
  });
  expect(await page.evaluate(() => window.errors.map((e) => e.code))).toEqual(["not_unlocked"]);
  expect(await page.evaluate(() => window.errors[0]?.recoverable)).toBe(true);

  await gesture(page, "window.E.unlock()");
  expect(await page.evaluate(() => window.E.state)).toBe("ready");

  // An OS interruption looks like this. 0.1.0 kept reporting unlocked:true here.
  await page.evaluate(() => window.E.context.suspend());
  expect(await page.evaluate(() => window.E.state)).toBe("interrupted");

  await page.evaluate(() => window.E.context.resume());
  expect(await page.evaluate(() => window.E.state)).toBe("ready");

  expect(await page.evaluate(() => window.log)).toEqual(["state:ready", "state:interrupted", "state:ready"]);
  await context.close();
});

test("undefined options take the defaults; invalid ones throw from createEngine", async ({ page }) => {
  const resolved = await page.evaluate(() => {
    const e = window.A.createEngine({
      levels: { fftSize: undefined, hopMs: undefined },
      vad: { sensitivity: undefined },
      audio: { deviceId: "headset-abc" },
    });
    return { fftSize: e.options.levels.fftSize, hopMs: e.options.levels.hopMs, sensitivity: e.options.vad.sensitivity, audio: e.options.audio };
  });
  expect(resolved.fftSize).toBe(2048);
  expect(resolved.hopMs).toBe(16);
  expect(resolved.sensitivity).toBe(0.5);
  expect(resolved.audio).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: "headset-abc" });

  const thrown = await page.evaluate(() => {
    try {
      window.A.createEngine({ levels: { fftSize: 1000 } });
      return null;
    } catch (err) {
      const e = err as { name: string; code: string };
      return { name: e.name, code: e.code };
    }
  });
  expect(thrown).toEqual({ name: "AudioError", code: "invalid_option" });
});

test("close is terminal — nothing resurrects a context", async ({ page }) => {
  await gesture(page, "window.E.unlock()");
  await page.evaluate(() => window.E.close());
  expect(await page.evaluate(() => window.E.state)).toBe("closed");
  expect(await page.evaluate(() => window.log[window.log.length - 1])).toBe("state:closed");

  const afterClose = await page.evaluate(async () => {
    const codeOf = (fn: () => unknown) => Promise.resolve().then(fn).then(() => "ok", (e: { code: string }) => e.code);
    return {
      context: await codeOf(() => window.E.context),
      unlock: await codeOf(() => window.E.unlock()),
      open: await codeOf(() => window.E.mic.open()),
      state: window.E.state,
    };
  });
  expect(afterClose).toEqual({ context: "engine_closed", unlock: "engine_closed", open: "engine_closed", state: "closed" });
  await page.evaluate(() => window.E.close()); // idempotent
});

test("device loss is a state and an event, and the mic can recover", async ({ page }) => {
  await gesture(page, "window.E.mic.open()");
  expect(await page.evaluate(() => ({ state: window.E.mic.state, ready: window.E.mic.isReady }))).toEqual({ state: "ready", ready: true });

  // Headphones unplugged / OS revoked / another app took it. The browser reports
  // that by firing `ended` on the track — and, per spec, `stop()` does NOT fire it
  // (that is how the library tells its own close() apart from loss), so we end the
  // track and dispatch the event the way the platform would.
  await page.evaluate(() =>
    window.E.mic.mediaStream!.getTracks().forEach((t) => {
      t.stop();
      t.dispatchEvent(new Event("ended"));
    }),
  );
  await page.waitForFunction(() => window.E.mic.state === "lost");

  const after = await page.evaluate(() => ({ ready: window.E.mic.isReady, stream: window.E.mic.mediaStream, errors: window.errors }));
  expect(after.ready).toBe(false);
  expect(after.stream).toBeNull();
  expect(after.errors).toHaveLength(1);
  expect(after.errors[0]).toMatchObject({ code: "device_lost", recoverable: true });

  await gesture(page, "window.E.mic.open()");
  expect(await page.evaluate(() => window.E.mic.state)).toBe("ready");
  expect(await page.evaluate(() => window.log.filter((l) => l.startsWith("mic:")))).toEqual([
    "mic:requesting", "mic:ready", "mic:lost", "mic:requesting", "mic:ready",
  ]);
});

test("permission denied is thrown AND emitted, once, and is a state", async ({ page }) => {
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
  });
  const result = await gesture(page, "window.E.mic.open().then(() => 'ok', e => ({ code: e.code, recoverable: e.recoverable }))");
  expect(result).toEqual({ code: "permission_denied", recoverable: false });
  expect(await page.evaluate(() => window.E.mic.state)).toBe("denied");
  expect(await page.evaluate(() => window.errors.map((e) => e.code))).toEqual(["permission_denied"]);
});

test("no microphone is a state, not a crash", async ({ page }) => {
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("none", "NotFoundError"));
  });
  const result = await gesture(page, "window.E.mic.open().then(() => 'ok', e => e.code)");
  expect(result).toBe("no_microphone");
  expect(await page.evaluate(() => window.E.mic.state)).toBe("unavailable");
});

test("devices, settings, device selection, and a clean close", async ({ page }) => {
  await gesture(page, "window.E.mic.open()");
  const devices = await page.evaluate(async () => (await window.E.mic.devices()).map((d) => ({ id: d.deviceId, kind: d.kind })));
  expect(devices.length).toBeGreaterThan(0);
  expect(devices.every((d) => d.kind === "audioinput")).toBe(true);
  expect(await page.evaluate(() => window.E.mic.isPresent)).toBe(true);

  const settings = await page.evaluate(() => window.E.mic.settings());
  expect(settings).not.toBeNull();
  expect(typeof settings!.sampleRate).toBe("number");

  await page.evaluate(() => window.E.mic.close());
  expect(await page.evaluate(() => ({ state: window.E.mic.state, stream: window.E.mic.mediaStream }))).toEqual({ state: "idle", stream: null });

  await gesture(page, `window.E.mic.open({ device: ${JSON.stringify(devices[0].id)} })`);
  expect(await page.evaluate(() => window.E.mic.state)).toBe("ready");

  await page.evaluate(() => window.E.mic.close());
  // Our own close() must never be reported as device loss.
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});

test("concurrent opens share one request", async ({ page }) => {
  const same = await gesture(page, "Promise.all([window.E.mic.open(), window.E.mic.open()]).then(([a, b]) => a === b)");
  expect(same).toBe(true);
  expect(await page.evaluate(() => window.log.filter((l) => l === "mic:requesting"))).toHaveLength(1);
});

test("open({ stream }) treats a supplied MediaStream as the microphone — sensing, levels, loss and replacement included", async ({ page }) => {
  const r = (await gesture(page, `(async () => {
    const E = window.E;
    await E.unlock();
    const ctx = E.context;
    const mk = (db) => {
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator(); osc.frequency.value = 440;
      const g = ctx.createGain(); g.gain.value = Math.pow(10, db / 20) * Math.SQRT2;
      osc.connect(g).connect(dest); osc.start();
      return dest.stream;
    };
    const loud = mk(-12);
    const opened = await E.mic.open({ stream: loud });
    const same = await E.mic.open({ stream: loud });
    let max = 0;
    const off = E.levels.on("frame", (f) => { max = Math.max(max, f.mic.level); });
    await new Promise((r) => setTimeout(r, 600));
    off();
    const vadLevel = E.vad.level;
    const settings = E.mic.settings();
    // a different stream replaces the open one
    const quiet = mk(-60);
    const replaced = await E.mic.open({ stream: quiet });
    const stateAfterReplace = E.mic.state;
    // and its track ending is device loss
    for (const t of quiet.getTracks()) { t.stop(); t.dispatchEvent(new Event("ended")); }
    await new Promise((r) => setTimeout(r, 50));
    return {
      opened: opened === loud, same: same === loud, state: stateAfterReplace, replaced: replaced === quiet && replaced !== loud,
      max, vadLevel, hasSettings: settings !== null && typeof settings.sampleRate === "number",
      lost: E.mic.state, errors: window.errors.map((e) => e.code), log: window.log,
    };
  })()`)) as { opened: boolean; same: boolean; state: string; replaced: boolean; max: number; vadLevel: number | null; hasSettings: boolean; lost: string; errors: string[]; log: string[] };
  expect(r).toMatchObject({ opened: true, same: true, state: "ready", replaced: true, hasSettings: true, lost: "lost", errors: ["device_lost"] });
  expect(r.max).toBeGreaterThan(0.5); // a −12 dBFS tone on the mic tap
  expect(r.vadLevel).not.toBeNull();
  expect(r.log.filter((l) => l === "mic:ready")).toHaveLength(2); // opened, then re-opened with the replacement
});
