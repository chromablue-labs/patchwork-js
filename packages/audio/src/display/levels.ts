import { follower, levelFromRms, peak, rms } from "../dsp";
import type { Engine } from "../engine";
import { AudioError } from "../errors";
import { validateLevelsOptions } from "../options";
import type { LevelsEvents, LevelsFrame, LevelsOptions, LevelsPcm, SourceLevel } from "../types";
import { createHistory, type History } from "./history";

type Listener = { fn: (frame: LevelsFrame) => void; minGapMs: number; lastAt: number };

const SILENT: SourceLevel = Object.freeze({ rms: 0, peak: 0, level: 0 });

/** After the last source goes quiet the loop keeps running this long so the strip visibly drains. */
const DRAIN_EXTRA_MS = 200;

/**
 * Display data — *what should I draw?* Three analysers: the mix (mic + player,
 * the only place they meet), the mic-only tap and the player tap, so a
 * visualiser can colour by who is talking instead of guessing.
 *
 * Every number is on the audio clock: the followers use elapsed time, the bar
 * strip turns over on `hopMs` of `AudioContext.currentTime`. Reading at 30 Hz
 * or 120 Hz draws the same picture.
 *
 * The frame loop runs only while something feeds the mix tap and someone is
 * listening; `read()` computes a frame on demand for your own rAF loop.
 */
export class Levels {
  private opts: LevelsOptions;
  private mix: AnalyserNode | null = null;
  private micTap: AnalyserNode | null = null;
  private playerTap: AnalyserNode | null = null;
  private scratch: Float32Array<ArrayBuffer> = new Float32Array(0);
  private micAttached: MediaStreamAudioSourceNode | null = null;
  private playerAttached: GainNode | null = null;

  private readonly history: History;
  private smoothed = { mix: 0, mic: 0, player: 0 };
  private lastT: number | null = null;
  private frame: LevelsFrame | null = null;
  private pcmCache: { t: number; pcm: LevelsPcm } | null = null;

  private readonly listeners = new Set<Listener>();
  private readonly activeListeners = new Set<(active: boolean) => void>();
  private raf = 0;
  private looping = false;
  private inactiveSince: number | null = null;
  private wasActive = false;

  /** @internal Use `audio.levels`. */
  constructor(private readonly engine: Engine) {
    this.opts = { ...engine.options.levels };
    this.history = createHistory(this.opts.historyMs, this.opts.hopMs);
    engine.on("mic", (state) => {
      if (state === "ready") this.attachMic();
      else if (state === "idle" || state === "lost" || state === "denied" || state === "unavailable") this.micAttached = null;
      this.reconsider();
    });
    engine.on("player", () => {
      this.attachPlayer();
      this.reconsider();
    });
  }

  get options(): LevelsOptions {
    return this.opts;
  }
  /** Validated like `createEngine`; applies live. Throws `invalid_option`. */
  set options(patch: Partial<LevelsOptions>) {
    let next: LevelsOptions;
    try {
      next = validateLevelsOptions({ ...this.opts, ...patch });
    } catch (err) {
      throw this.engine.fail(err instanceof AudioError ? err : new AudioError("invalid_option", String(err)));
    }
    const prev = this.opts;
    this.opts = next;
    if (next.historyMs !== prev.historyMs || next.hopMs !== prev.hopMs) this.history.resize(next.historyMs, next.hopMs);
    if (next.fftSize !== prev.fftSize) {
      for (const a of [this.mix, this.micTap, this.playerTap]) if (a) a.fftSize = next.fftSize;
      this.scratch = new Float32Array(next.fftSize);
    }
    this.pcmCache = null;
  }

  /** True while the loop has a reason to run: something feeds the mix tap, or it is still draining. */
  get active(): boolean {
    return this.wasActive;
  }

  /**
   * Frames at display rate, or at `hz` for anything that should not re-render
   * that often (React state, SVG). The rate limit is on the audio clock too.
   */
  on<K extends keyof LevelsEvents>(event: K, fn: (payload: LevelsEvents[K]) => void, opts: { hz?: number } = {}): () => void {
    if (event === "active") {
      const cb = fn as (active: boolean) => void;
      this.activeListeners.add(cb);
      return () => {
        this.activeListeners.delete(cb);
      };
    }
    const hz = opts.hz;
    if (hz !== undefined && !(Number.isFinite(hz) && hz > 0)) {
      throw this.engine.fail(new AudioError("invalid_option", `hz must be a positive number (got ${String(hz)})`));
    }
    const listener: Listener = { fn: fn as Listener["fn"], minGapMs: hz ? 1000 / hz : 0, lastAt: -Infinity };
    this.listeners.add(listener);
    this.reconsider();
    return () => {
      this.listeners.delete(listener);
      this.reconsider();
    };
  }

  /** Pull a frame now — for your own rAF or WebGL loop. Memoised per audio-clock tick. */
  read(): LevelsFrame {
    const ctx = this.contextOrNull();
    if (!ctx || !this.mix) return this.silentFrame(ctx ? ctx.currentTime * 1000 : 0);
    const t = ctx.currentTime * 1000;
    if (this.frame && this.frame.t === t) return this.frame;
    return this.compute(t);
  }

  /** The mix tap's samples and spectrum — explicit, copied on demand, memoised per frame. */
  pcm(): LevelsPcm {
    const frame = this.read();
    if (this.pcmCache && this.pcmCache.t === frame.t) return this.pcmCache.pcm;
    const size = this.opts.fftSize;
    const timeDomain = new Float32Array(size);
    const frequency = new Float32Array(size / 2);
    if (this.mix) {
      readTimeDomain(this.mix, timeDomain);
      this.mix.getFloatFrequencyData(frequency);
    } else {
      frequency.fill(-Infinity);
    }
    const pcm = { timeDomain, frequency };
    this.pcmCache = { t: frame.t, pcm };
    return pcm;
  }

  /** @internal */
  dispose(): void {
    this.stopLoop();
    this.listeners.clear();
    this.activeListeners.clear();
    for (const a of [this.mix, this.micTap, this.playerTap]) {
      try { a?.disconnect(); } catch { /* already gone */ }
    }
    this.mix = this.micTap = this.playerTap = null;
    this.micAttached = this.playerAttached = null;
    this.setActive(false);
  }

  // --- graph -------------------------------------------------------------

  private contextOrNull(): AudioContext | null {
    if (this.engine.state === "closed") return null;
    try {
      return this.engine.hasContext ? this.engine.context : null;
    } catch {
      return null;
    }
  }

  private ensureAnalysers(ctx: AudioContext): void {
    if (this.mix) return;
    const make = () => {
      const a = ctx.createAnalyser();
      a.fftSize = this.opts.fftSize;
      a.smoothingTimeConstant = 0; // our own followers smooth on elapsed time; this one smooths per call
      return a;
    };
    this.mix = make();
    this.micTap = make();
    this.playerTap = make();
    this.scratch = new Float32Array(this.opts.fftSize);
  }

  private attachMic(): void {
    try {
      const source = this.engine.mic.sourceNode();
      if (this.micAttached === source) return;
      this.ensureAnalysers(this.engine.context);
      source.connect(this.micTap as AnalyserNode);
      source.connect(this.mix as AnalyserNode);
      this.micAttached = source;
    } catch {
      // the mic closed between the event and now; the next "ready" retries
    }
  }

  private attachPlayer(): void {
    try {
      const out = this.engine.player.output;
      if (this.playerAttached === out) return;
      this.ensureAnalysers(this.engine.context);
      out.connect(this.playerTap as AnalyserNode);
      out.connect(this.mix as AnalyserNode);
      this.playerAttached = out;
    } catch {
      // engine closed
    }
  }

  // --- frames --------------------------------------------------------------

  private measure(analyser: AnalyserNode | null, key: keyof Levels["smoothed"], dt: number): SourceLevel {
    if (!analyser) return SILENT;
    const buf = this.scratch;
    readTimeDomain(analyser, buf);
    const r = rms(buf);
    const p = peak(buf);
    const instant = levelFromRms(r);
    const prev = this.smoothed[key];
    const level = this.lastT === null ? instant : follower(prev, instant, dt, this.opts.attackMs, this.opts.releaseMs);
    this.smoothed[key] = level;
    return { rms: r, peak: p, level };
  }

  private compute(t: number): LevelsFrame {
    const dt = this.lastT === null ? 0 : Math.max(0, t - this.lastT);
    const mixL = this.measure(this.mix, "mix", dt);
    const mic = this.micAttached ? this.measure(this.micTap, "mic", dt) : SILENT;
    const player = this.playerAttached ? this.measure(this.playerTap, "player", dt) : SILENT;
    this.lastT = t;
    this.history.tick(mixL.level, t);
    const frame: LevelsFrame = {
      t,
      rms: mixL.rms,
      peak: mixL.peak,
      level: mixL.level,
      speaking: this.engine.vad.speaking === true,
      bars: this.history.bars.slice(),
      hopMs: this.history.hopMs,
      hopProgress: this.history.progress,
      mic,
      player,
    };
    this.frame = frame;
    return frame;
  }

  private silentFrame(t: number): LevelsFrame {
    return {
      t,
      rms: 0,
      peak: 0,
      level: 0,
      speaking: false,
      bars: new Float32Array(this.history.bars.length),
      hopMs: this.history.hopMs,
      hopProgress: 0,
      mic: SILENT,
      player: SILENT,
    };
  }

  // --- the loop --------------------------------------------------------------

  private get fed(): boolean {
    return this.engine.mic.mediaStream !== null || this.engine.player.state === "playing";
  }

  /** Start or stop the loop according to who is feeding and who is listening. */
  private reconsider(): void {
    const listening = this.listeners.size > 0;
    if (this.fed) {
      this.inactiveSince = null;
      this.setActive(true);
      if (listening) this.startLoop();
      else this.stopLoop();
      return;
    }
    if (!this.wasActive) {
      this.stopLoop();
      return;
    }
    // Draining: the loop keeps running for historyMs so the strip visibly
    // empties, then stops itself — unless nobody is watching, in which case
    // there is nothing to drain for.
    const ctx = this.contextOrNull();
    if (this.inactiveSince === null) this.inactiveSince = ctx ? ctx.currentTime * 1000 : 0;
    if (!ctx || !listening) {
      this.stopLoop();
      this.setActive(false);
    } else {
      this.startLoop();
    }
  }

  private startLoop(): void {
    if (this.looping || typeof requestAnimationFrame !== "function") return;
    this.looping = true;
    const step = () => {
      if (!this.looping) return;
      this.raf = requestAnimationFrame(step);
      const ctx = this.contextOrNull();
      if (!ctx || !this.mix) return;
      const frame = this.read();
      for (const l of this.listeners) {
        if (frame.t - l.lastAt < l.minGapMs - 0.5) continue;
        l.lastAt = frame.t;
        l.fn(frame);
      }
      if (this.inactiveSince !== null && frame.t - this.inactiveSince > this.opts.historyMs + this.opts.releaseMs + DRAIN_EXTRA_MS) {
        this.stopLoop();
        this.setActive(false);
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  private stopLoop(): void {
    if (!this.looping) return;
    this.looping = false;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf);
  }

  private setActive(active: boolean): void {
    if (active === this.wasActive) return;
    this.wasActive = active;
    for (const fn of this.activeListeners) fn(active);
  }
}

/** Safari < 14.1 has only the byte version. */
function readTimeDomain(analyser: AnalyserNode, out: Float32Array<ArrayBuffer>): void {
  if (typeof analyser.getFloatTimeDomainData === "function") {
    analyser.getFloatTimeDomainData(out);
    return;
  }
  const bytes = new Uint8Array(out.length);
  analyser.getByteTimeDomainData(bytes);
  for (let i = 0; i < out.length; i++) out[i] = (bytes[i] - 128) / 128;
}
