import { expect, test, type Page } from "@playwright/test";

/**
 * Slice 2 — transport in. Each test is named for the 0.1.0 finding it pins.
 * Chromium's fake capture device produces a steady tone, which is enough to
 * prove frames carry real audio and to decode them.
 */

async function gesture(page: Page, expr: string): Promise<unknown> {
  await page.evaluate((src) => {
    window.gesture = new Function(`return (${src})`) as () => unknown;
  }, expr);
  await page.click("#gesture");
  return page.evaluate(() => window.gestureResult);
}

// Wrap Int16 PCM in a WAV header so decodeAudioData can judge it standalone.
const WAV_HELPER = `
  const wav = (i16, rate = 16000) => {
    const b = new ArrayBuffer(44 + i16.length * 2), v = new DataView(b);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + i16.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, i16.length * 2, true);
    new Int16Array(b, 44).set(i16);
    return b;
  };
  const decodeMs = async (buf) => { try { return (await window.E.context.decodeAudioData(buf)).duration * 1000; } catch (e) { return "FAILED:" + e.name; } };
`;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    window.log = [];
    window.errors = [];
    window.E = window.A.createEngine();
    window.E.on("mic", (s) => window.log.push(`mic:${s}`));
    window.E.on("error", (e) => window.errors.push({ code: e.code, recoverable: e.recoverable, message: e.message }));
  });
});

test("a take released during the permission prompt is not lost and leaves nothing running", async ({ page }) => {
  // 0.1.0: release() returned null here and the recorder ran until the page died.
  const r = await gesture(page, `(() => {
    const t = window.E.mic.record();
    const opening = t.state;
    return t.stop().then((c) => ({ opening, state: t.state, bytes: c.blob.size, durationMs: c.durationMs, cancelled: c.cancelled, mic: window.E.mic.state }));
  })()`);
  expect(r).toMatchObject({ opening: "opening", state: "stopped", durationMs: 0, cancelled: false, mic: "ready" });
  expect(await page.evaluate(() => window.E.mic.isListening)).toBe(false);
});

test("a take records real audio and reports its duration on the audio clock", async ({ page }) => {
  const r = (await gesture(page, `(async () => {
    const t = window.E.mic.record();
    await new Promise((r) => setTimeout(r, 600));
    const c = await t.stop();
    const decoded = await window.E.context.decodeAudioData(await c.blob.arrayBuffer());
    return { bytes: c.blob.size, mime: c.mimeType, durationMs: c.durationMs, decodedMs: decoded.duration * 1000, mic: window.E.mic.state, state: t.state };
  })()`)) as { bytes: number; mime: string; durationMs: number; decodedMs: number; mic: string; state: string };
  expect(r.bytes).toBeGreaterThan(0);
  expect(r.mime).toContain("audio/");
  expect(r.durationMs).toBeGreaterThan(450);
  expect(r.durationMs).toBeLessThan(900);
  expect(Math.abs(r.durationMs - r.decodedMs)).toBeLessThan(120);
  expect(r).toMatchObject({ mic: "ready", state: "stopped" });
  expect(await page.evaluate(() => window.log)).toEqual(["mic:requesting", "mic:ready", "mic:recording", "mic:ready"]);
});

test("a second record() throws take_in_progress synchronously — and is emitted", async ({ page }) => {
  const r = await gesture(page, `(() => {
    const t = window.E.mic.record();
    let code = null;
    try { window.E.mic.record(); } catch (e) { code = e.code; }
    t.cancel();
    return t.stop().then(() => ({ code, emitted: window.errors.map((e) => e.code) }));
  })()`);
  expect(r).toEqual({ code: "take_in_progress", emitted: ["take_in_progress"] });
});

test("maxDurationMs stops a runaway take and emits take-limit", async ({ page }) => {
  const r = await gesture(page, `(async () => {
    const e = window.A.createEngine({ take: { maxDurationMs: 300 } });
    let limited = null;
    e.on("take-limit", (t) => { limited = t.state; });
    const t = e.mic.record();
    await new Promise((r) => setTimeout(r, 800));
    const c = await t.stop();
    const out = { limited, state: t.state, durationMs: c.durationMs, mic: e.mic.state };
    e.close();
    return out;
  })()`) as { limited: string | null; state: string; durationMs: number; mic: string };
  expect(r.limited).toBe("recording"); // fired while still recording, then stopped for us
  expect(r.state).toBe("stopped");
  expect(r.durationMs).toBeGreaterThan(200);
  expect(r.durationMs).toBeLessThan(500);
  expect(r.mic).toBe("ready");
});

test("cancel() discards the take; closeAfterTake closes the mic afterwards", async ({ page }) => {
  const r = await gesture(page, `(async () => {
    const e = window.A.createEngine({ take: { closeAfterTake: true } });
    const t = e.mic.record();
    await new Promise((r) => setTimeout(r, 200));
    t.cancel();
    const c = await t.stop();
    const out = { state: t.state, cancelled: c.cancelled, bytes: c.blob.size, durationMs: c.durationMs, mic: e.mic.state, stream: e.mic.mediaStream };
    e.close();
    return out;
  })()`);
  expect(r).toEqual({ state: "cancelled", cancelled: true, bytes: 0, durationMs: 0, mic: "idle", stream: null });
});

test("pcm16k: 20 ms Int16 frames, each decodable alone, final frame delivered at stop", async ({ page }) => {
  const r = (await gesture(page, `(async () => {
    ${WAV_HELPER}
    const s = window.E.mic.stream({ format: "pcm16k" });
    const frames = [];
    s.on("data", (f) => frames.push(f));
    await new Promise((r) => setTimeout(r, 1000));
    const before = frames.length;
    const tStop = window.E.context.currentTime * 1000;
    await s.stop();
    const last = frames[frames.length - 1];
    const lens = frames.map((f) => f.data.length);
    const spacing = frames.slice(1).map((f, i) => f.t - frames[i].t);
    const loud = frames.filter((f) => { let m = 0; for (const v of f.data) m = Math.max(m, Math.abs(v)); return m > 100; }).length;
    const picks = [frames[0], frames[Math.floor(frames.length / 2)], frames[frames.length - 2]];
    const decoded = [];
    for (const f of picks) decoded.push(await decodeMs(wav(f.data)));
    return {
      format: s.format, state: s.state, mic: window.E.mic.state,
      before, total: frames.length,
      allInt16: frames.every((f) => f.data instanceof Int16Array),
      fullFrames: lens.slice(0, -1).every((l) => l === 320), lastLen: lens[lens.length - 1],
      minSpacing: Math.min(...spacing), maxSpacing: Math.max(...spacing), monotonic: spacing.every((d) => d > 0),
      finalDelivered: frames.length > before || last.t >= tStop - 25,
      decoded, loud, speaking: frames[0].speaking,
    };
  })()`)) as Record<string, number | string | boolean | (number | string)[]>;

  expect(r.format).toBe("pcm16k");
  expect(r.allInt16).toBe(true);
  expect(r.before as number).toBeGreaterThan(38); // ~50 frames/s
  expect(r.before as number).toBeLessThan(62);
  expect(r.fullFrames).toBe(true);
  expect(r.lastLen as number).toBeGreaterThan(0);
  expect(r.lastLen as number).toBeLessThanOrEqual(320);
  expect(r.minSpacing as number).toBeGreaterThan(5);
  expect(r.maxSpacing as number).toBeLessThan(60);
  expect(r.monotonic).toBe(true);
  expect(r.finalDelivered).toBe(true);
  for (const ms of r.decoded as (number | string)[]) {
    expect(typeof ms).toBe("number"); // "FAILED:…" would be the 0.1.0 behaviour
    expect(Math.abs((ms as number) - 20)).toBeLessThan(3);
  }
  expect(r.loud as number).toBeGreaterThanOrEqual(1); // Chromium's fake device beeps briefly a few times a second; silence between
  expect(typeof r.speaking).toBe("boolean"); // the gate stamps every frame (null only when vad.enabled is false)
  expect(r).toMatchObject({ state: "stopped", mic: "ready" });
});

test("opus: chunk rate equals the timeslice, chunks are cumulative, final chunk delivered at stop", async ({ page }) => {
  const r = (await gesture(page, `(async () => {
    const s = window.E.mic.stream({ format: "opus", timesliceMs: 200 });
    const chunks = [];
    s.on("data", (f) => chunks.push(f));
    await new Promise((r) => setTimeout(r, 1200));
    const before = chunks.length;
    const tStop = window.E.context.currentTime * 1000;
    await s.stop();
    const decode = async (blob) => { try { return (await window.E.context.decodeAudioData(await blob.arrayBuffer())).duration; } catch (e) { return "FAILED:" + e.name; } };
    return {
      before, total: chunks.length, allBlobs: chunks.every((c) => c.data instanceof Blob),
      chunk0Alone: await decode(chunks[0].data),
      chunk1Alone: await decode(chunks[1].data),
      joined: await decode(new Blob(chunks.map((c) => c.data), { type: chunks[0].data.type })),
      finalDelivered: chunks.length > before || chunks[chunks.length - 1].t >= tStop - 5,
      state: s.state, mic: window.E.mic.state,
    };
  })()`)) as Record<string, number | string | boolean>;

  expect(r.allBlobs).toBe(true);
  expect(r.before as number).toBeGreaterThanOrEqual(4); // 1.2 s / 200 ms ≈ 6
  expect(r.before as number).toBeLessThanOrEqual(8); // 0.1.0's requestData() nudge gave ~11
  expect(typeof r.chunk0Alone).toBe("number");
  expect(String(r.chunk1Alone)).toMatch(/^FAILED/); // cumulative by nature — documented, and pinned here
  expect(typeof r.joined).toBe("number");
  expect(r.finalDelivered).toBe(true);
  expect(r).toMatchObject({ state: "stopped", mic: "ready" });
});

test("record() during a stream and stream() during a take both refuse loudly", async ({ page }) => {
  const r = await gesture(page, `(async () => {
    const s = window.E.mic.stream();
    let a = null; try { window.E.mic.record(); } catch (e) { a = e.code; }
    await s.stop();
    const t = window.E.mic.record();
    let b = null; try { window.E.mic.stream(); } catch (e) { b = e.code; }
    t.cancel(); await t.stop();
    return { a, b, mic: window.E.mic.state };
  })()`);
  expect(r).toEqual({ a: "stream_in_progress", b: "take_in_progress", mic: "ready" });
});

test("device loss ends a live stream and frees the mic", async ({ page }) => {
  await gesture(page, `(async () => { window.S = window.E.mic.stream(); await new Promise((r) => setTimeout(r, 200)); })()`);
  expect(await page.evaluate(() => (window as unknown as { S: { state: string } }).S.state)).toBe("live");
  await page.evaluate(() =>
    window.E.mic.mediaStream!.getTracks().forEach((t) => {
      t.stop();
      t.dispatchEvent(new Event("ended"));
    }),
  );
  await page.waitForFunction(() => (window as unknown as { S: { state: string } }).S.state === "stopped");
  expect(await page.evaluate(() => ({ mic: window.E.mic.state, errors: window.errors.map((e) => e.code) }))).toEqual({
    mic: "lost",
    errors: ["device_lost"],
  });
});

test("for await sees frames; breaking out leaves the stream live", async ({ page }) => {
  const r = await gesture(page, `(async () => {
    const s = window.E.mic.stream();
    let n = 0;
    for await (const f of s) { if (f.data.length > 0) n++; if (n === 5) break; }
    const stateAfterBreak = s.state;
    await s.stop();
    return { n, stateAfterBreak, stateAfterStop: s.state, mic: window.E.mic.state };
  })()`);
  expect(r).toEqual({ n: 5, stateAfterBreak: "live", stateAfterStop: "stopped", mic: "ready" });
});
