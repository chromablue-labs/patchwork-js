import type { Engine } from "../engine";
import { AudioError, fromBrowserError } from "../errors";
import { Emitter } from "../events";
import type { Mic } from "../lifecycle/mic";
import type { StreamFormat, StreamFrame, StreamState } from "../types";
import { pickMimeType, recorderSupported } from "./mime";

type StreamEvents<F extends Int16Array | Blob> = { data: StreamFrame<F>; end: undefined };

/** How long `stop()` waits for the audio thread before ending anyway (a suspended context never answers). */
const STOP_GRACE_MS = 500;

/**
 * Live capture. Push (`on("data")`) or pull (`for await`) — both see every
 * frame. `stop()` resolves after the final frame has been delivered, by
 * contract. `pcm16k` frames come from the AudioWorklet and are each complete;
 * `opus` chunks come from MediaRecorder and are cumulative.
 */
export class Stream<F extends Int16Array | Blob = Int16Array | Blob> {
  state: StreamState = "opening";
  readonly format: StreamFormat;

  private readonly bus = new Emitter<StreamEvents<F>>();
  private readonly ended: Promise<void>;
  private resolveEnded!: () => void;
  private rejectEnded!: (error: AudioError) => void;
  private iterating = false;
  private queue: StreamFrame<F>[] = [];
  private waiters: ((result: IteratorResult<StreamFrame<F>>) => void)[] = [];
  private stopRequested = false;
  private stopping = false;
  private teardown: (() => void) | null = null;
  private ctx: AudioContext | null = null;

  /** @internal Use `mic.stream()`. */
  constructor(
    private readonly engine: Engine,
    private readonly mic: Mic,
    private readonly opts: { format: StreamFormat; timesliceMs: number },
  ) {
    this.format = opts.format;
    this.ended = new Promise<void>((resolve, reject) => {
      this.resolveEnded = resolve;
      this.rejectEnded = reject;
    });
    this.ended.catch(() => undefined);
    void this.begin();
  }

  on<K extends keyof StreamEvents<F>>(event: K, fn: (payload: StreamEvents<F>[K]) => void): () => void {
    return this.bus.on(event, fn);
  }

  /** Frames as they arrive. Breaking out of the loop leaves the stream live; call `stop()` to end it. */
  [Symbol.asyncIterator](): AsyncIterator<StreamFrame<F>> {
    this.iterating = true;
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.state === "stopped") return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.iterating = false;
        this.queue = [];
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  /** End capture. Resolves once the last frame is out — always within ~500 ms, even if the context is suspended. */
  stop(): Promise<void> {
    if (this.state === "stopped") return this.ended;
    if (this.state === "opening") {
      this.stopRequested = true;
      return this.ended;
    }
    if (!this.stopping) {
      this.stopping = true;
      const teardown = this.teardown;
      this.teardown = null;
      teardown?.();
      setTimeout(() => this.end(), STOP_GRACE_MS);
    }
    return this.ended;
  }

  /** @internal The mic went away underneath us. */
  abort(): void {
    void this.stop();
  }

  private async begin(): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await this.mic.open();
    } catch (error) {
      this.fail(error as AudioError);
      return;
    }
    if (this.stopRequested) {
      this.end();
      return;
    }
    try {
      this.ctx = this.engine.context;
      if (this.opts.format === "pcm16k") await this.beginPcm(stream);
      else this.beginOpus(stream);
    } catch (error) {
      this.fail(this.engine.fail(fromBrowserError(error, "unsupported")));
      return;
    }
    this.state = "live";
    this.mic.transition("streaming");
    if (this.stopRequested) void this.stop(); // stop() arrived while the worklet was loading
  }

  private async beginPcm(_stream: MediaStream): Promise<void> {
    const capture = await this.mic.capture();
    capture.startStream((message) => {
      if (message.type === "frame") this.push({ data: new Int16Array(message.data) as F, t: message.t, speaking: message.speaking });
      else this.end(); // stream-end: the worklet has flushed its partial frame
    });
    this.teardown = () => capture.stopStream();
    this.onEnd = () => capture.clearStream();
  }

  private beginOpus(stream: MediaStream): void {
    if (!recorderSupported()) throw new AudioError("unsupported", "MediaRecorder is not available in this browser");
    const ctx = this.ctx!;
    const mimeType = pickMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.push({ data: event.data as F, t: ctx.currentTime * 1000, speaking: null });
    };
    recorder.onstop = () => this.end();
    recorder.onerror = () => this.fail(this.engine.fail(new AudioError("device_lost", "Recording failed mid-stream")));
    recorder.start(this.opts.timesliceMs); // no requestData() nudge: the timeslice IS the chunk rate
    this.teardown = () => {
      if (recorder.state !== "inactive") recorder.stop(); // fires the final dataavailable, then stop → end()
      else this.end();
    };
    this.onEnd = () => {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
    };
  }

  private onEnd: (() => void) | null = null;

  private push(frame: StreamFrame<F>): void {
    if (this.state === "stopped") return;
    this.bus.emit("data", frame);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: frame, done: false });
    else if (this.iterating) this.queue.push(frame);
  }

  private end(): void {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.teardown = null;
    this.onEnd?.();
    this.onEnd = null;
    this.mic.release(this);
    this.bus.emit("end", undefined);
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    this.resolveEnded();
  }

  private fail(error: AudioError): void {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.teardown = null;
    this.onEnd?.();
    this.onEnd = null;
    this.mic.release(this);
    this.bus.emit("end", undefined);
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    this.rejectEnded(error);
  }
}
