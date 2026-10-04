import type { Engine } from "../engine";
import { AudioError } from "../errors";
import { Emitter } from "../events";
import type { PlayResult, PlaySource, PlayerEvents, PlayerState, SinkOptions } from "../types";
import { decodeSource } from "./decode";
import { MseSink, PcmSink, type Sink } from "./sink";

type Item = {
  decoded: Promise<AudioBuffer>;
  resolve: (result: PlayResult) => void;
  reject: (error: AudioError) => void;
  result: Promise<PlayResult>;
  /** Set by interruptAll() on anything queued or still decoding. */
  cancelled: boolean;
};

type Current = { item: Item; node: AudioBufferSourceNode; startedAt: number; durationMs: number; cut: boolean };

/** Volume changes ramp over this long so they never click. */
const RAMP_S = 0.02;

/**
 * Transport out — *play this, tell me how it ended.* Plays audio that comes
 * from outside the engine (the TTS reply) so that it is heard (destination),
 * seen (the `output` tap that Levels reads), and interruptible (barge-in).
 *
 *   play()    — now: interrupts the current item, clears the queue
 *   enqueue() — after: sentence-by-sentence TTS without clips cutting each other off
 *   stream()  — a sink for bytes as they arrive; PCM is scheduled gaplessly on the audio clock
 */
export class Player {
  state: PlayerState = "idle";

  private readonly bus = new Emitter<PlayerEvents>();
  private out: GainNode | null = null;
  private queue: Item[] = [];
  private decoding: Item | null = null;
  private current: Current | null = null;
  private sink: Sink | null = null;
  private volumeValue = 1;

  /** @internal Use `audio.player`. */
  constructor(private readonly engine: Engine) {}

  /** The post-volume node — the player tap. Levels attach here; consumers rarely need it. */
  get output(): GainNode {
    if (!this.out) {
      const ctx = this.engine.context;
      this.out = ctx.createGain();
      this.out.gain.value = this.volumeValue;
      this.out.connect(ctx.destination);
    }
    return this.out;
  }

  get volume(): number {
    return this.volumeValue;
  }
  /** 0..1, ramped over 20 ms. */
  set volume(value: number) {
    const v = Math.min(1, Math.max(0, value));
    this.volumeValue = v;
    if (this.out) {
      const ctx = this.engine.context;
      this.out.gain.cancelScheduledValues(ctx.currentTime);
      this.out.gain.setTargetAtTime(v, ctx.currentTime, RAMP_S / 3);
    }
  }

  on<K extends keyof PlayerEvents>(event: K, fn: (payload: PlayerEvents[K]) => void): () => void {
    return this.bus.on(event, fn);
  }

  /** Play now. Whatever is playing is interrupted and the queue is cleared. */
  async play(src: PlaySource): Promise<PlayResult> {
    this.engine.assertOpen();
    await this.engine.unlock();
    this.interruptAll();
    const item = this.makeItem(src);
    this.queue.push(item);
    void this.pump();
    return item.result;
  }

  /** Play after the current item and anything already queued. */
  async enqueue(src: PlaySource): Promise<PlayResult> {
    this.engine.assertOpen();
    await this.engine.unlock();
    const item = this.makeItem(src);
    this.queue.push(item);
    void this.pump();
    return item.result;
  }

  /** A sink for audio arriving as bytes. Interrupts the current item and clears the queue. */
  stream(opts: SinkOptions): Sink {
    this.engine.assertOpen();
    this.interruptAll();
    const sink =
      opts.format === "pcm"
        ? new PcmSink(this.engine, this.output, this.checkRate(opts.sampleRate ?? 24000))
        : this.mse(opts.format);
    this.sink = sink;
    this.setState("playing");
    this.bus.emit("start", undefined);
    void sink.done.then((result) => {
      if (this.sink !== sink) return;
      this.sink = null;
      this.bus.emit(result.completed ? "end" : "interrupted", result);
      if (result.completed) void this.pump();
      else this.setState("idle");
    });
    return sink;
  }

  /** Stop the current item and drop the queue. */
  stop(): void {
    this.interruptAll();
  }

  /** Stop the current item and play the next queued one. */
  skip(): void {
    if (this.current) {
      this.finishCurrent(false);
      void this.pump();
    } else if (this.decoding) {
      const item = this.decoding;
      this.decoding = null;
      item.cancelled = true;
      item.resolve({ completed: false, playedMs: 0 });
      void this.pump();
    } else if (this.sink) {
      const sink = this.sink;
      this.sink = null;
      sink.abort();
      void sink.done.then((result) => {
        this.bus.emit("interrupted", result);
        void this.pump();
      });
    }
  }

  /** @internal */
  dispose(): void {
    this.interruptAll();
    this.bus.clear();
    try { this.out?.disconnect(); } catch { /* already gone */ }
    this.out = null;
  }

  private makeItem(src: PlaySource): Item {
    let resolve!: Item["resolve"];
    let reject!: Item["reject"];
    const result = new Promise<PlayResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    result.catch(() => undefined);
    const decoded = decodeSource(this.engine.context, src);
    decoded.catch(() => undefined);
    return { decoded, resolve, reject, result, cancelled: false };
  }

  private async pump(): Promise<void> {
    // One pump at a time: a second caller while the head is still decoding
    // would shift the next item and race it against the head.
    if (this.current || this.sink || this.decoding) return;
    const item = this.queue.shift();
    if (!item) {
      if (this.state === "playing") {
        this.setState("idle");
        this.bus.emit("queue-empty", undefined);
      }
      return;
    }
    this.decoding = item;
    let buffer: AudioBuffer;
    try {
      buffer = await item.decoded;
    } catch (err) {
      this.decoding = null;
      const error = err instanceof AudioError ? err : new AudioError("decode_failed", "The audio could not be decoded", err);
      item.reject(this.engine.fail(error));
      if (!item.cancelled) void this.pump();
      return;
    }
    this.decoding = null;
    if (item.cancelled || this.current || this.sink) {
      item.resolve({ completed: false, playedMs: 0 }); // interrupted while decoding (no-op if already settled)
      return;
    }
    const ctx = this.engine.context;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.output);
    const current: Current = { item, node, startedAt: ctx.currentTime, durationMs: buffer.duration * 1000, cut: false };
    node.onended = () => {
      if (this.current === current && !current.cut) this.finishCurrent(true);
    };
    this.current = current;
    node.start();
    this.setState("playing");
    this.bus.emit("start", undefined);
  }

  private finishCurrent(completed: boolean): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    current.cut = !completed;
    let playedMs = current.durationMs;
    try {
      playedMs = Math.max(0, Math.min(current.durationMs, (this.engine.context.currentTime - current.startedAt) * 1000));
    } catch { /* engine closed */ }
    if (!completed) {
      current.node.onended = null;
      try { current.node.stop(); } catch { /* already stopped */ }
    }
    current.node.disconnect();
    const result = { completed, playedMs };
    current.item.resolve(result);
    this.bus.emit(completed ? "end" : "interrupted", result);
    if (completed) void this.pump();
  }

  private interruptAll(): void {
    const queued = this.queue;
    this.queue = [];
    for (const item of queued) {
      item.cancelled = true;
      item.resolve({ completed: false, playedMs: 0 });
    }
    if (this.decoding) {
      this.decoding.cancelled = true;
      this.decoding = null;
    }
    if (this.current) this.finishCurrent(false);
    if (this.sink) {
      const sink = this.sink;
      this.sink = null;
      sink.abort();
      void sink.done.then((result) => this.bus.emit("interrupted", result));
    }
    this.setState("idle");
  }

  private mse(format: "mp3" | "opus"): Sink {
    try {
      return new MseSink(this.engine, this.output, format);
    } catch (err) {
      throw this.engine.fail(err instanceof AudioError ? err : new AudioError("unsupported", "MediaSource is not available"));
    }
  }

  private checkRate(rate: number): number {
    if (!Number.isFinite(rate) || rate < 8000 || rate > 96000) {
      throw this.engine.fail(new AudioError("invalid_option", `sampleRate must be between 8000 and 96000 (got ${String(rate)})`));
    }
    return rate;
  }

  private setState(state: PlayerState): void {
    if (state === this.state) return;
    this.state = state;
    this.engine.emit("player", state);
  }
}
