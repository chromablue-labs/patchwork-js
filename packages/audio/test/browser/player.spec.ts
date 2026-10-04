import { expect, test } from "@playwright/test";
import { FAKE_MEDIA_ARGS, SILENCE_FIXTURE } from "../../playwright.config";
import { PAGE_HELPERS, gesture } from "./page-helpers";

/**
 * Slice 4 — the Player. The microphone here plays the SILENCE fixture (room
 * noise only), so anything the gate hears can only have come through the
 * graph — which is exactly what "playback never trips the VAD" needs.
 */
test.use({ launchOptions: { args: [...FAKE_MEDIA_ARGS, `--use-file-for-fake-audio-capture=${SILENCE_FIXTURE}`] } });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    window.log = [];
    window.errors = [];
    window.E = window.A.createEngine();
    window.E.on("error", (e) => window.errors.push({ code: e.code, recoverable: e.recoverable, message: e.message }));
    window.E.on("player", (s) => window.log.push(`player:${s}`));
    for (const name of ["start", "end", "interrupted", "queue-empty"] as const) {
      window.E.player.on(name, (r) => window.log.push(r ? `${name}:${r.completed}` : name));
    }
  });
});

test("play() resolves completed with playedMs from the audio clock, and the events tell the story", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const r = await window.E.player.play(toneWav(500, 440));
    return { ...r, state: window.E.player.state, log: window.log };
  })()`)) as { completed: boolean; playedMs: number; state: string; log: string[] };
  expect(r.completed).toBe(true);
  expect(r.playedMs).toBeGreaterThan(470);
  expect(r.playedMs).toBeLessThan(560);
  expect(r.state).toBe("idle");
  expect(r.log).toEqual(["player:playing", "start", "end:true", "player:idle", "queue-empty"]);
});

test("stop() mid-clip resolves completed:false — the caller can tell", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const p = window.E.player.play(toneWav(2000, 440));
    await sleep(200);
    window.E.player.stop();
    const r = await p;
    return { ...r, state: window.E.player.state, interrupted: window.log.includes("interrupted:false") };
  })()`)) as { completed: boolean; playedMs: number; state: string; interrupted: boolean };
  expect(r.completed).toBe(false);
  expect(r.playedMs).toBeGreaterThan(150);
  expect(r.playedMs).toBeLessThan(350);
  expect(r).toMatchObject({ state: "idle", interrupted: true });
});

test("enqueue() plays sentences in order without cutting each other off", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const t0 = window.E.context.currentTime;
    const results = await Promise.all([
      window.E.player.enqueue(toneWav(300, 330)),
      window.E.player.enqueue(toneWav(300, 440)),
      window.E.player.enqueue(toneWav(300, 550)),
    ]);
    return { results, totalMs: (window.E.context.currentTime - t0) * 1000, log: window.log };
  })()`)) as { results: { completed: boolean }[]; totalMs: number; log: string[] };
  expect(r.results.map((x) => x.completed)).toEqual([true, true, true]);
  expect(r.totalMs).toBeGreaterThan(850);
  expect(r.totalMs).toBeLessThan(1150);
  expect(r.log.filter((l) => l === "end:true")).toHaveLength(3);
  expect(r.log.filter((l) => l === "queue-empty")).toHaveLength(1);
});

test("play() is 'now': it interrupts the current clip and drops the queue; skip() moves on", async ({ page }) => {
  const r = await gesture(page, `(async () => { ${PAGE_HELPERS}
    const first = window.E.player.play(toneWav(2000, 330));
    const queued = window.E.player.enqueue(toneWav(300, 440));
    await sleep(150);
    const replacement = window.E.player.play(toneWav(300, 550));
    const [a, b, c] = await Promise.all([first, queued, replacement]);

    const d = window.E.player.play(toneWav(2000, 330));
    const e = window.E.player.enqueue(toneWav(200, 440));
    await sleep(100);
    window.E.player.skip();
    const [dr, er] = await Promise.all([d, e]);
    return { a: a.completed, b, c: c.completed, d: dr.completed, e: er.completed };
  })()`);
  expect(r).toEqual({ a: false, b: { completed: false, playedMs: 0 }, c: true, d: false, e: true });
});

test("volume ramps to the target instead of stepping", async ({ page }) => {
  const r = await gesture(page, `(async () => { ${PAGE_HELPERS}
    const p = window.E.player.play(toneWav(600, 440));
    await sleep(50);
    window.E.player.volume = 0.25;
    const immediately = window.E.player.output.gain.value;
    await sleep(100);
    const later = window.E.player.output.gain.value;
    await p;
    return { immediately, later, volume: window.E.player.volume };
  })()`) as { immediately: number; later: number; volume: number };
  expect(r.immediately).toBeGreaterThan(0.25); // still on its way down
  expect(Math.abs(r.later - 0.25)).toBeLessThan(0.02);
  expect(r.volume).toBe(0.25);
});

test("playback never trips the VAD: the assistant talks loudly, the gate stays quiet", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    await window.E.mic.open();
    let starts = 0;
    window.E.vad.on("speech-start", () => starts++);
    await sleep(600); // let the floor settle on the room noise
    const seen = new Set();
    const p = window.E.player.play(toneWav(2000, 220, 24000, -6)); // loud
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) { seen.add(window.E.vad.speaking); await sleep(50); }
    const r = await p;
    return { completed: r.completed, starts, speakingSeen: [...seen], level: window.E.vad.level, threshold: window.E.vad.threshold };
  })()`)) as { completed: boolean; starts: number; speakingSeen: boolean[]; level: number; threshold: number };
  expect(r.completed).toBe(true); // nothing interrupted it
  expect(r.starts).toBe(0);
  expect(r.speakingSeen).toEqual([false]);
  expect(r.level).toBeLessThan(r.threshold);
});

test("pcm sink: paced 20 ms chunks with odd splits play gaplessly, first audio within 80 ms", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const pcm = tone(1000, 440, 24000, -12);
    const bytes = new Uint8Array(pcm.buffer);
    const sink = window.E.player.stream({ format: "pcm", sampleRate: 24000 });
    let at = 0, i = 0;
    while (at < bytes.length) {
      const size = i % 2 ? 961 : 959; // deliberately split samples across chunks
      sink.write(bytes.subarray(at, Math.min(at + size, bytes.length)));
      at += size; i++;
      await sleep(20);
    }
    const r = await sink.end();
    return { ...r, stats: sink.stats, state: sink.state, player: window.E.player.state, chunks: i };
  })()`)) as { completed: boolean; playedMs: number; stats: { chunks: number; bytes: number; underruns: number; firstAudioMs: number }; state: string; player: string; chunks: number };
  expect(r.completed).toBe(true);
  expect(r.playedMs).toBeGreaterThan(950);
  expect(r.playedMs).toBeLessThan(1100);
  expect(r.stats.chunks).toBe(r.chunks);
  expect(r.stats.bytes).toBe(48000);
  expect(r.stats.underruns).toBeLessThanOrEqual(2);
  expect(r.stats.firstAudioMs).toBeLessThan(80);
  expect(r).toMatchObject({ state: "done", player: "idle" });
});

test("pcm sink: abort() cuts it and reports what played", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const sink = window.E.player.stream({ format: "pcm", sampleRate: 24000 });
    sink.write(new Uint8Array(tone(1500, 440).buffer));
    const done = sink.end();
    await sleep(250);
    sink.abort();
    const r = await done;
    return { ...r, player: window.E.player.state };
  })()`)) as { completed: boolean; playedMs: number; player: string };
  expect(r.completed).toBe(false);
  expect(r.playedMs).toBeGreaterThan(150);
  expect(r.playedMs).toBeLessThan(400);
  expect(r.player).toBe("idle");
});

test("container sink: a real webm/opus stream chopped into pieces plays through MediaSource", async ({ page }) => {
  const supported = await page.evaluate(() => window.A.MseSink.supported("opus"));
  test.skip(!supported, "MediaSource cannot play webm/opus here");
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const take = window.E.mic.record();
    await sleep(1000);
    const clip = await take.stop();
    const bytes = new Uint8Array(await clip.blob.arrayBuffer());
    const sink = window.E.player.stream({ format: "opus" });
    const piece = Math.ceil(bytes.length / 6);
    for (let at = 0; at < bytes.length; at += piece) { sink.write(bytes.subarray(at, at + piece)); await sleep(30); }
    const r = await sink.end();
    return { ...r, format: sink.format, chunks: sink.stats.chunks, player: window.E.player.state };
  })()`)) as { completed: boolean; playedMs: number; format: string; chunks: number; player: string };
  expect(r.completed).toBe(true);
  expect(r.playedMs).toBeGreaterThan(700);
  expect(r.playedMs).toBeLessThan(1400);
  expect(r).toMatchObject({ format: "opus", chunks: 6, player: "idle" });
});

test("stream() interrupts a playing clip", async ({ page }) => {
  const r = await gesture(page, `(async () => { ${PAGE_HELPERS}
    const p = window.E.player.play(toneWav(2000, 440));
    await sleep(100);
    const sink = window.E.player.stream({ format: "pcm" });
    const clip = await p;
    sink.abort();
    await sink.done;
    return { clip: clip.completed };
  })()`);
  expect(r).toEqual({ clip: false });
});
