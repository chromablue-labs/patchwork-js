import type { Engine } from "../engine";
import { AudioError } from "../errors";
import type { PlayResult, SinkFormat, SinkState, SinkStats } from "../types";
import { toBytes } from "./decode";

/** What the Player needs from either sink. */
export interface Sink {
  readonly format: SinkFormat;
  readonly state: SinkState;
  readonly stats: SinkStats;
  write(chunk: ArrayBuffer | ArrayBufferView): void;
  end(): Promise<PlayResult>;
  abort(): void;
  /** @internal Resolves when the sink is done, however it ended. */
  readonly done: Promise<PlayResult>;
}

type Settle = (result: PlayResult) => void;

/** Scheduling safety margin for the first chunk, and for recovering after an underrun. */
const LEAD_S = 0.02;

/**
 * Streaming PCM playback: each chunk becomes an AudioBuffer started exactly
 * where the previous one ends, on the audio clock. Gapless as long as bytes
 * keep arriving; a late chunk is scheduled `LEAD_S` ahead and counted as an
 * underrun. Int16 LE mono; an odd trailing byte is carried into the next chunk.
 */
export class PcmSink implements Sink {
  readonly format = "pcm" as const;
  state: SinkState = "open";
  readonly stats: SinkStats = { chunks: 0, bytes: 0, underruns: 0, firstAudioMs: null };
  readonly done: Promise<PlayResult>;

  private settle!: Settle;
  private readonly ready: Promise<void>;
  private isReady = false;
  private readonly early: Uint8Array[] = [];
  private carry: number | null = null;
  private nextTime = 0;
  private firstStart: number | null = null;
  private scheduledS = 0;
  private active = new Set<AudioBufferSourceNode>();
  private readonly createdAt: number;

  constructor(
    private readonly engine: Engine,
    private readonly output: GainNode,
    private readonly sampleRate: number,
  ) {
    this.done = new Promise<PlayResult>((resolve) => (this.settle = resolve));
    this.createdAt = performance.now();
    this.ready = engine.unlock().then(() => {
      this.isReady = true;
      for (const bytes of this.early.splice(0)) this.schedule(bytes);
      if (this.state === "ending") this.maybeFinish();
    });
    this.ready.catch(() => this.finish(false));
  }

  write(chunk: ArrayBuffer | ArrayBufferView): void {
    if (this.state !== "open") return;
    const bytes = toBytes(chunk);
    this.stats.chunks++;
    this.stats.bytes += bytes.byteLength;
    if (!this.isReady) this.early.push(bytes.slice());
    else this.schedule(bytes);
  }

  end(): Promise<PlayResult> {
    if (this.state === "open") {
      this.state = "ending";
      this.maybeFinish();
    }
    return this.done;
  }

  abort(): void {
    if (this.state === "done") return;
    for (const node of this.active) {
      node.onended = null;
      try { node.stop(); } catch { /* not started */ }
    }
    this.active.clear();
    this.finish(false);
  }

  private schedule(bytes: Uint8Array): void {
    let data = bytes;
    if (this.carry !== null) {
      const joined = new Uint8Array(bytes.byteLength + 1);
      joined[0] = this.carry;
      joined.set(bytes, 1);
      data = joined;
      this.carry = null;
    }
    const samples = data.byteLength >> 1;
    if (data.byteLength & 1) this.carry = data[data.byteLength - 1];
    if (samples === 0) return;

    const ctx = this.engine.context;
    const buffer = ctx.createBuffer(1, samples, this.sampleRate);
    const out = buffer.getChannelData(0);
    const view = new DataView(data.buffer, data.byteOffset, samples * 2);
    for (let i = 0; i < samples; i++) out[i] = view.getInt16(i * 2, true) / 32768;

    const now = ctx.currentTime;
    let at = this.nextTime;
    if (this.firstStart === null) {
      at = now + LEAD_S;
      this.firstStart = at;
      this.stats.firstAudioMs = performance.now() - this.createdAt + LEAD_S * 1000;
    } else if (at < now) {
      this.stats.underruns++;
      at = now + LEAD_S;
    }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.output);
    node.onended = () => {
      this.active.delete(node);
      node.disconnect();
      if (this.state === "ending") this.maybeFinish();
    };
    this.active.add(node);
    node.start(at);
    this.nextTime = at + buffer.duration;
    this.scheduledS += buffer.duration;
  }

  private maybeFinish(): void {
    if (this.state !== "ending" || !this.isReady) return;
    if (this.active.size === 0) this.finish(true);
  }

  private finish(completed: boolean): void {
    if (this.state === "done") return;
    this.state = "done";
    let playedMs = 0;
    if (this.firstStart !== null) {
      try {
        playedMs = Math.max(0, Math.min(this.scheduledS, this.engine.context.currentTime - this.firstStart)) * 1000;
      } catch { /* engine closed */ }
    }
    this.settle({ completed, playedMs });
  }
}

const MIME: Record<Exclude<SinkFormat, "pcm">, string> = {
  mp3: "audio/mpeg",
  opus: 'audio/webm;codecs="opus"',
};

/**
 * Streaming container playback through MediaSource Extensions on an <audio>
 * element, routed into the graph with createMediaElementSource so it still
 * reaches the player tap. Higher latency than PCM (MSE buffers) and no
 * sample-exact timing, but it plays what the API sends today.
 */
export class MseSink implements Sink {
  readonly format: SinkFormat;
  state: SinkState = "open";
  readonly stats: SinkStats = { chunks: 0, bytes: 0, underruns: 0, firstAudioMs: null };
  readonly done: Promise<PlayResult>;

  private settle!: Settle;
  private readonly element: HTMLAudioElement;
  private readonly media: MediaSource;
  private buffer: SourceBuffer | null = null;
  private readonly pending: Uint8Array<ArrayBuffer>[] = [];
  private node: MediaElementAudioSourceNode | null = null;
  private endRequested = false;
  private readonly createdAt: number;

  static supported(format: Exclude<SinkFormat, "pcm">): boolean {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(MIME[format]);
  }

  constructor(
    engine: Engine,
    private readonly output: GainNode,
    format: Exclude<SinkFormat, "pcm">,
  ) {
    if (!MseSink.supported(format)) {
      throw new AudioError("unsupported", `This browser cannot stream ${MIME[format]} through MediaSource`);
    }
    this.format = format;
    this.done = new Promise<PlayResult>((resolve) => (this.settle = resolve));
    this.createdAt = performance.now();
    this.media = new MediaSource();
    this.element = new Audio();
    this.element.src = URL.createObjectURL(this.media);
    this.element.onended = () => this.finish(true);
    this.element.onplaying = () => {
      if (this.stats.firstAudioMs === null) this.stats.firstAudioMs = performance.now() - this.createdAt;
    };
    this.media.addEventListener("sourceopen", () => {
      URL.revokeObjectURL(this.element.src);
      this.buffer = this.media.addSourceBuffer(MIME[format]);
      this.buffer.addEventListener("updateend", () => this.pump());
      this.pump();
    });
    void engine.unlock().then(
      () => {
        const ctx = engine.context;
        this.node = ctx.createMediaElementSource(this.element);
        this.node.connect(this.output);
        return this.element.play();
      },
      () => this.finish(false),
    ).catch(() => this.finish(false));
  }

  write(chunk: ArrayBuffer | ArrayBufferView): void {
    if (this.state !== "open") return;
    const bytes = toBytes(chunk).slice();
    this.stats.chunks++;
    this.stats.bytes += bytes.byteLength;
    this.pending.push(bytes);
    this.pump();
  }

  end(): Promise<PlayResult> {
    if (this.state === "open") {
      this.state = "ending";
      this.endRequested = true;
      this.pump();
    }
    return this.done;
  }

  abort(): void {
    if (this.state === "done") return;
    this.element.pause();
    this.finish(false);
  }

  private pump(): void {
    const sb = this.buffer;
    if (!sb || sb.updating) return;
    const next = this.pending.shift();
    if (next) {
      try { sb.appendBuffer(next); } catch { this.finish(false); }
      return;
    }
    if (this.endRequested && this.media.readyState === "open") {
      try { this.media.endOfStream(); } catch { /* already ended */ }
    }
  }

  private finish(completed: boolean): void {
    if (this.state === "done") return;
    this.state = "done";
    const playedMs = Math.max(0, this.element.currentTime) * 1000;
    this.element.onended = null;
    this.element.onplaying = null;
    try { this.node?.disconnect(); } catch { /* already gone */ }
    this.element.removeAttribute("src");
    this.element.load();
    this.settle({ completed, playedMs });
  }
}
