import { expect, test, type Page } from "@playwright/test";

/**
 * Slice 3 — sensing, against the generated fixture (see global-setup.ts):
 * a ~1000 ms utterance and a ~400 ms utterance per 4 s loop, over room noise.
 */

async function gesture(page: Page, expr: string): Promise<unknown> {
  await page.evaluate((src) => {
    window.gesture = new Function(`return (${src})`) as () => unknown;
  }, expr);
  await page.click("#gesture");
  return page.evaluate(() => window.gestureResult);
}

type Ev = { e: string; at: number; t: number };

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    window.log = [];
    window.errors = [];
    window.V = [];
    window.E = window.A.createEngine();
    window.E.on("error", (e) => window.errors.push({ code: e.code, recoverable: e.recoverable, message: e.message }));
    for (const name of ["speech-start", "speech-end", "turn-end"] as const) {
      window.E.vad.on(name, (ev) => window.V.push({ e: name, at: ev.at, t: ev.t }));
    }
  });
});

test("speech-start / speech-end / turn-end fire from real audio with honest onsets, on the audio clock", async ({ page }) => {
  await gesture(page, "window.E.mic.open()");
  await page.waitForFunction(() => window.V.filter((v) => v.e === "turn-end").length >= 3, undefined, { timeout: 16_000 });
  const events = (await page.evaluate(() => window.V)) as Ev[];

  // Strict alternation: start, end, turn, start, end, turn, …
  const kinds = events.map((v) => v.e);
  for (let i = 0; i < kinds.length; i++) expect(kinds[i]).toBe(["speech-start", "speech-end", "turn-end"][i % 3]);

  const utterances: number[] = [];
  for (let i = 0; i + 2 < events.length; i += 3) {
    const [start, end, turn] = [events[i], events[i + 1], events[i + 2]];
    utterances.push(end.at - start.at);
    expect(start.t - start.at).toBeGreaterThanOrEqual(80); // onset is retroactive by minSpeechMs
    expect(start.t - start.at).toBeLessThan(160);
    expect(end.t - end.at).toBeGreaterThanOrEqual(300); // confirmed pauseMs after the silence began
    expect(end.t - end.at).toBeLessThan(380);
    expect(Math.abs(turn.at - end.at)).toBeLessThan(30); // the same silence
    expect(turn.t - turn.at).toBeGreaterThanOrEqual(900);
    expect(turn.t - turn.at).toBeLessThan(980);
  }
  // Both utterance lengths from the fixture show up (the loop may start anywhere).
  expect(utterances.some((ms) => Math.abs(ms - 1000) < 120)).toBe(true);
  expect(utterances.some((ms) => Math.abs(ms - 400) < 120)).toBe(true);
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});

test("pcm16k frames carry the gate's verdict, and it tracks the audio", async ({ page }) => {
  const r = (await gesture(page, `(async () => {
    const s = window.E.mic.stream({ format: "pcm16k" });
    const frames = [];
    s.on("data", (f) => frames.push(f));
    await new Promise((r) => setTimeout(r, 4200));
    await s.stop();
    const peakOf = (f) => { let m = 0; for (const v of f.data) m = Math.max(m, Math.abs(v)); return m; };
    const on = frames.filter((f) => f.speaking === true), off = frames.filter((f) => f.speaking === false);
    const mean = (a) => a.reduce((s, f) => s + peakOf(f), 0) / Math.max(1, a.length);
    return { total: frames.length, on: on.length, off: off.length, nulls: frames.filter((f) => f.speaking === null).length, onPeak: mean(on), offPeak: mean(off) };
  })()`)) as { total: number; on: number; off: number; nulls: number; onPeak: number; offPeak: number };
  expect(r.nulls).toBe(0);
  expect(r.on).toBeGreaterThan(20);
  expect(r.off).toBeGreaterThan(20);
  expect(r.onPeak).toBeGreaterThan(r.offPeak * 3);
});

test("speaking, level, threshold and noiseFloor are readable and sane", async ({ page }) => {
  await gesture(page, "window.E.mic.open()");
  await page.waitForFunction(() => window.V.length >= 2, undefined, { timeout: 12_000 });
  const v = await page.evaluate(() => ({
    speaking: window.E.vad.speaking, level: window.E.vad.level, threshold: window.E.vad.threshold, floor: window.E.vad.noiseFloor, enabled: window.E.vad.enabled,
  }));
  expect(typeof v.speaking).toBe("boolean");
  expect(v.level).toBeGreaterThanOrEqual(0);
  expect(v.level).toBeLessThanOrEqual(1);
  expect(v.threshold).toBeGreaterThan(0);
  expect(v.threshold).toBeLessThan(1);
  expect(v.floor).toBeGreaterThan(-95); // the fixture's room noise is −70 dBFS
  expect(v.floor).toBeLessThan(-55);
  expect(v.enabled).toBe(true);
});

test("vad.options updates the running worklet, and is validated", async ({ page }) => {
  await gesture(page, "window.E.mic.open()");
  await page.evaluate(() => {
    window.E.vad.options = { minSpeechMs: 5000 }; // nothing in the fixture is 5 s long
    window.V = [];
  });
  await page.waitForTimeout(4500);
  expect(await page.evaluate(() => window.V.filter((v) => v.e === "speech-start").length)).toBe(0);
  await page.evaluate(() => {
    window.E.vad.options = { minSpeechMs: 80 };
  });
  await page.waitForFunction(() => window.V.some((v) => v.e === "speech-start"), undefined, { timeout: 6000 });

  const bad = await page.evaluate(() => {
    try {
      window.E.vad.options = { pauseMs: 1000, turnEndMs: 500 };
      return null;
    } catch (err) {
      return (err as { code: string }).code;
    }
  });
  expect(bad).toBe("invalid_option");
  expect(await page.evaluate(() => window.E.vad.options.pauseMs)).toBe(300); // unchanged
});

test("vad.enabled: false runs no stage — frames say null and nothing fires", async ({ page }) => {
  const r = await gesture(page, `(async () => {
    const e = window.A.createEngine({ vad: { enabled: false } });
    let fired = 0;
    e.vad.on("speech-start", () => fired++);
    const s = e.mic.stream({ format: "pcm16k" });
    const speaking = new Set();
    s.on("data", (f) => speaking.add(f.speaking));
    await new Promise((r) => setTimeout(r, 1500));
    await s.stop();
    const out = { enabled: e.vad.enabled, fired, speaking: [...speaking] };
    e.close();
    return out;
  })()`);
  expect(r).toEqual({ enabled: false, fired: 0, speaking: [null] });
});

test("closing the mic mid-speech emits speech-end and clears speaking", async ({ page }) => {
  await gesture(page, "window.E.mic.open()");
  await page.waitForFunction(() => window.E.vad.speaking === true, undefined, { timeout: 10_000 });
  await page.evaluate(() => {
    window.V = [];
    window.E.mic.close();
  });
  expect(await page.evaluate(() => ({ speaking: window.E.vad.speaking, level: window.E.vad.level, ended: window.V.map((v) => v.e) }))).toEqual({
    speaking: false,
    level: 0,
    ended: ["speech-end"],
  });
});
