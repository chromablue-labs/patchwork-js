import { AudioError, createEngine, pickMimeType, type Engine, type EngineOptions, type StreamFrame } from "@usepatchwork/audio";
import { syntheticVoice, toneSamples, wavBlob, type SourceHandle, type SyntheticOptions } from "./sources";

/**
 * The browser test suite, in the page. Each scenario is one attack from the
 * teardown (spec §2) run against a scratch engine, so the panel is a
 * permanent, visible regression suite that needs no microphone and no
 * backend. Scratch engines feed synthetic speech through `mic.open({ stream })`.
 */
export type Outcome = { ok: boolean; detail: string };

export type Scenario = {
  key: string;
  title: string;
  /** Which §2 finding this would catch coming back. */
  finding: string;
  run(ctx: Ctx): Promise<Outcome>;
};

export type Ctx = {
  scratch(options?: EngineOptions): Engine;
  voice(engine: Engine, opts?: Partial<SyntheticOptions>): Promise<SourceHandle>;
  sleep(ms: number): Promise<void>;
  until<T>(read: () => T | null | undefined | false, timeoutMs: number, what: string): Promise<T>;
  log(text: string): void;
};

const tone = (ms: number, hz = 440, db = -12) => wavBlob(toneSamples(ms, hz, 24000, db), 24000);

function expect(cond: boolean, detail: string): Outcome {
  return { ok: cond, detail };
}

export const SCENARIOS: Scenario[] = [
  {
    key: "undefined-options",
    title: "undefined options take the defaults",
    finding: "0.1.0 crashed on `{ vad: { sensitivity: undefined } }`",
    async run(ctx) {
      const e = ctx.scratch({ vad: { sensitivity: undefined, pauseMs: undefined }, levels: { fftSize: undefined } });
      return expect(e.options.vad.sensitivity === 0.5 && e.options.vad.pauseMs === 300 && e.options.levels.fftSize === 2048, `sensitivity ${e.options.vad.sensitivity}, pauseMs ${e.options.vad.pauseMs}, fftSize ${e.options.levels.fftSize}`);
    },
  },
  {
    key: "invalid-options",
    title: "invalid options throw invalid_option from createEngine",
    finding: "bad numbers used to surface later, from a getter",
    async run() {
      const codes: string[] = [];
      for (const bad of [{ vad: { sensitivity: 2 } }, { levels: { fftSize: 1000 } }, { vad: { pauseMs: 500, turnEndMs: 200 } }] as EngineOptions[]) {
        try {
          createEngine(bad).close();
          codes.push("no throw");
        } catch (err) {
          codes.push(err instanceof AudioError ? err.code : "other");
        }
      }
      return expect(codes.every((c) => c === "invalid_option"), codes.join(", "));
    },
  },
  {
    key: "close-terminal",
    title: "close() is terminal",
    finding: "a closed engine used to be silently resurrectable",
    async run(ctx) {
      const e = ctx.scratch();
      await e.unlock();
      e.close();
      let code = "no throw";
      try {
        await e.unlock();
      } catch (err) {
        code = err instanceof AudioError ? err.code : "other";
      }
      return expect(e.state === "closed" && code === "engine_closed", `state ${e.state}, unlock → ${code}`);
    },
  },
  {
    key: "statechange",
    title: "state follows the context: suspend → interrupted, resume → ready",
    finding: "`unlocked` was a cached flag that went stale",
    async run(ctx) {
      const e = ctx.scratch();
      const seen: string[] = [];
      e.on("state", (s) => seen.push(s));
      await e.unlock();
      await e.context.suspend();
      await ctx.until(() => e.state === "interrupted", 1000, "interrupted");
      await e.context.resume();
      await ctx.until(() => seen[seen.length - 1] === "ready", 1000, "the ready event");
      return expect(seen.includes("interrupted") && e.state === "ready", `events: ${seen.join(" → ")}`);
    },
  },
  {
    key: "release-before-open",
    title: "release before the mic opens never loses the take",
    finding: "the first-take race: stop() during the permission prompt threw",
    async run(ctx) {
      const e = ctx.scratch();
      await e.unlock();
      const take = e.mic.record(); // opens the (real or fake) mic itself
      const opening = take.state;
      const clip = await take.stop(); // before it is open: an empty clip, nothing left running
      return expect(opening === "opening" && take.state === "stopped" && clip.durationMs === 0 && clip.blob.size === 0 && e.mic.state === "ready", `take ${opening} → ${take.state}, ${clip.durationMs} ms, ${clip.blob.size} B, mic ${e.mic.state}`);
    },
  },
  {
    key: "final-frame",
    title: "stream.stop() resolves after the final frame, then nothing",
    finding: "frames used to arrive after stop() had resolved",
    async run(ctx) {
      const e = ctx.scratch();
      await ctx.voice(e);
      const s = e.mic.stream({ format: "pcm16k" });
      let frames = 0;
      let afterStop = 0;
      let stopped = false;
      s.on("data", () => (stopped ? afterStop++ : frames++));
      await ctx.sleep(600);
      await s.stop();
      stopped = true;
      await ctx.sleep(300);
      return expect(frames >= 20 && afterStop === 0, `${frames} frames before stop, ${afterStop} after`);
    },
  },
  {
    key: "chunk-rate",
    title: "opus chunk rate equals the timeslice",
    finding: "0.1.0 delivered chunks at 1.76× the configured rate",
    async run(ctx) {
      if (!pickMimeType()) return { ok: true, detail: "MediaRecorder unsupported here — skipped" };
      const e = ctx.scratch();
      await ctx.voice(e);
      const s = e.mic.stream({ format: "opus", timesliceMs: 240 });
      let chunks = 0;
      s.on("data", () => chunks++);
      await ctx.sleep(1500);
      await s.stop();
      return expect(chunks >= 5 && chunks <= 8, `${chunks} chunks in 1.5 s at 240 ms (expect 6–7)`);
    },
  },
  {
    key: "pcm-standalone",
    title: "every pcm16k frame decodes on its own",
    finding: "streaming STT needs frames that stand alone",
    async run(ctx) {
      const e = ctx.scratch();
      await ctx.voice(e);
      const s = e.mic.stream({ format: "pcm16k" });
      const frames: Int16Array[] = [];
      s.on("data", (f: StreamFrame<Int16Array>) => frames.length < 30 && frames.push(f.data));
      await ctx.until(() => frames.length >= 30, 3000, "30 frames");
      await s.stop();
      let decoded = 0;
      for (const f of [frames[0], frames[15], frames[29]]) {
        const buf = await e.context.decodeAudioData(await wavBlob(f, 16000).arrayBuffer());
        if (Math.round(buf.duration * 1000) === 20) decoded++;
      }
      return expect(decoded === 3 && frames.every((f) => f.length === 320), `${decoded}/3 decoded as 20 ms; sizes ${[...new Set(frames.map((f) => f.length))].join(",")} samples`);
    },
  },
  {
    key: "opus-cumulative",
    title: "opus chunks are cumulative: chunk 1 alone fails, 0..n joined decodes",
    finding: "the docs claimed each chunk was a playable file",
    async run(ctx) {
      if (!pickMimeType()) return { ok: true, detail: "MediaRecorder unsupported here — skipped" };
      const e = ctx.scratch();
      await ctx.voice(e);
      const s = e.mic.stream({ format: "opus", timesliceMs: 200 });
      const chunks: Blob[] = [];
      s.on("data", (f: StreamFrame<Blob>) => chunks.push(f.data));
      await ctx.until(() => chunks.length >= 3, 3000, "3 chunks");
      await s.stop();
      const tryDecode = async (b: Blob) => e.context.decodeAudioData(await b.arrayBuffer()).then(() => true, () => false);
      const alone = await tryDecode(new Blob([chunks[1]], { type: chunks[0].type }));
      const joined = await tryDecode(new Blob(chunks.slice(0, 3), { type: chunks[0].type }));
      return expect(!alone && joined, `chunk 1 alone: ${alone ? "decodes" : "fails"}; 0..2 joined: ${joined ? "decodes" : "fails"}`);
    },
  },
  {
    key: "playback-vad",
    title: "playback never trips the VAD",
    finding: "self-barge-in: the assistant interrupted itself",
    async run(ctx) {
      const e = ctx.scratch();
      await ctx.voice(e, { levelDb: -100 }); // a quiet room, no voice
      let starts = 0;
      e.vad.on("speech-start", () => starts++);
      await ctx.sleep(400); // let the floor settle
      const r = await e.player.play(tone(1200, 440, -6));
      return expect(starts === 0 && r.completed, `${starts} speech-start(s) during a −6 dBFS tone; completed ${r.completed}`);
    },
  },
  {
    key: "barge-in",
    title: "barge-in fires on real voice over playback",
    finding: "the reason the mic-only tap exists",
    async run(ctx) {
      const e = ctx.scratch();
      await ctx.voice(e, { utteranceMs: 1200, gapMs: 400 });
      let barge: number | null = null;
      e.on("barge-in", (ev) => (barge = ev.at));
      const p = e.player.play(tone(6000, 330, -12));
      await ctx.until(() => barge !== null, 5000, "barge-in");
      const r = await p;
      return expect(!r.completed, `barge-in at ${(barge as number | null)?.toFixed(0)} ms; play() resolved completed ${r.completed} after ${r.playedMs.toFixed(0)} ms`);
    },
  },
  {
    key: "device-loss",
    title: "device loss becomes `lost` and a device_lost error",
    finding: "unplugging the mic was invisible",
    async run(ctx) {
      const e = ctx.scratch();
      const src = await ctx.voice(e);
      const codes: string[] = [];
      e.on("error", (err) => codes.push(err.code));
      for (const t of src.stream.getTracks()) {
        t.stop();
        t.dispatchEvent(new Event("ended")); // a local stop() does not fire `ended`
      }
      await ctx.until(() => e.mic.state === "lost", 1000, "lost");
      return expect(codes.includes("device_lost"), `mic ${e.mic.state}; errors ${codes.join(",") || "none"}`);
    },
  },
  {
    key: "turn-end-timing",
    title: "turn-end arrives turnEndMs after the silence began",
    finding: "the 253 ms overshoot the frame-counted smoother hid",
    async run(ctx) {
      const e = ctx.scratch({ vad: { turnEndMs: 700, pauseMs: 250 } });
      await ctx.voice(e, { utteranceMs: 900, gapMs: 2500 });
      const ends: { at: number; t: number }[] = [];
      e.vad.on("turn-end", (ev) => ends.push(ev));
      await ctx.until(() => ends.length >= 1, 8000, "a turn-end");
      const d = ends[0].t - ends[0].at;
      return expect(Math.abs(d - 700) <= 100, `t − at = ${d.toFixed(0)} ms vs turnEndMs 700`);
    },
  },
  {
    key: "levels-idle",
    title: "levels idle after the source stops",
    finding: "0.1.0 burned a 60 Hz loop forever",
    async run(ctx) {
      const e = ctx.scratch();
      let frames = 0;
      e.levels.on("frame", () => frames++);
      await ctx.voice(e);
      await ctx.sleep(400);
      const during = frames;
      e.mic.close();
      await ctx.sleep(1500); // history 700 + release 120 + grace
      const settled = frames;
      await ctx.sleep(400);
      return expect(during > 5 && frames === settled && !e.levels.active, `${during} frames while fed; ${frames - settled} after the drain; active ${e.levels.active}`);
    },
  },
  {
    key: "player-stop",
    title: "player.stop() resolves completed:false with the played time",
    finding: "a cut clip must say so",
    async run(ctx) {
      const e = ctx.scratch();
      const p = e.player.play(tone(2000));
      await ctx.sleep(300);
      e.player.stop();
      const r = await p;
      return expect(!r.completed && r.playedMs > 150 && r.playedMs < 600, `completed ${r.completed}, playedMs ${r.playedMs.toFixed(0)}`);
    },
  },
  {
    key: "enqueue-order",
    title: "enqueue() plays in order without cut-offs",
    finding: "sentence-by-sentence TTS",
    async run(ctx) {
      const e = ctx.scratch();
      await e.unlock();
      const t0 = e.context.currentTime;
      const rs = await Promise.all([e.player.enqueue(tone(200, 330)), e.player.enqueue(tone(200, 440)), e.player.enqueue(tone(200, 550))]);
      const total = (e.context.currentTime - t0) * 1000;
      return expect(rs.every((r) => r.completed) && total > 550 && total < 900, `${rs.map((r) => r.completed).join(",")} in ${total.toFixed(0)} ms (3 × 200)`);
    },
  },
  {
    key: "pcm-sink",
    title: "pcm sink: first audio under 100 ms, gapless when paced real-time",
    finding: "ENG-52's browser half",
    async run(ctx) {
      const e = ctx.scratch();
      await e.unlock();
      const sink = e.player.stream({ format: "pcm", sampleRate: 24000 });
      const bytes = new Uint8Array(await tone(1000, 440).arrayBuffer()).subarray(44);
      for (let o = 0; o < bytes.byteLength; o += 960) {
        sink.write(bytes.subarray(o, o + 960));
        await ctx.sleep(20);
      }
      const r = await sink.end();
      const first = sink.stats.firstAudioMs ?? Infinity;
      return expect(r.completed && first < 100 && sink.stats.underruns <= 2 && r.playedMs > 950, `first audio ${first.toFixed(0)} ms, underruns ${sink.stats.underruns}, ${sink.stats.chunks} chunks, played ${r.playedMs.toFixed(0)} ms, completed ${r.completed}`);
    },
  },
];

export async function runScenario(s: Scenario, log: (t: string) => void): Promise<Outcome & { ms: number }> {
  const engines: Engine[] = [];
  const sources: SourceHandle[] = [];
  const ctx: Ctx = {
    scratch(options) {
      const e = createEngine(options);
      engines.push(e);
      return e;
    },
    async voice(engine, opts = {}) {
      await engine.unlock();
      const h = syntheticVoice(engine, { levelDb: -22, noiseDb: -65, utteranceMs: 1400, gapMs: 1600, ...opts });
      sources.push(h);
      await engine.mic.open({ stream: h.stream });
      return h;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async until(read, timeoutMs, what) {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const v = read();
        if (v) return v;
        if (performance.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    log,
  };
  const started = performance.now();
  try {
    const out = await s.run(ctx);
    return { ...out, ms: performance.now() - started };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err), ms: performance.now() - started };
  } finally {
    for (const h of sources) h.stop();
    for (const e of engines) e.close();
  }
}
