import type { Engine } from "../engine";
import { AudioError } from "../errors";
import type { Mic } from "../lifecycle/mic";
import type { Clip, TakeState } from "../types";
import { pickMimeType, recorderSupported } from "./mime";

/**
 * One push-to-talk take. `mic.record()` returns this synchronously — even
 * while the permission prompt is still up — so the handle itself is the
 * generation token: a `stop()` that lands before the mic has opened is
 * recorded here and honoured the moment it can be. Nothing can be lost, and
 * no recorder can be left running with nobody holding it.
 */
export class Take {
  state: TakeState = "opening";

  private readonly result: Promise<Clip>;
  private resolveResult!: (clip: Clip) => void;
  private rejectResult!: (error: AudioError) => void;
  private readonly mimeType: string;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ctx: AudioContext | null = null;
  private startedAt = 0;
  private stopRequested = false;
  private cancelled = false;
  private limit: ReturnType<typeof setTimeout> | null = null;

  /** @internal Use `mic.record()`. */
  constructor(
    private readonly engine: Engine,
    private readonly mic: Mic,
  ) {
    this.result = new Promise<Clip>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    this.result.catch(() => undefined); // a take nobody awaits must not surface an unhandled rejection
    this.mimeType = pickMimeType(engine.options.take.mimeType) ?? "";
    void this.begin();
  }

  /** End the take. Resolves with the clip; rejects with the error that stopped the mic opening. */
  stop(): Promise<Clip> {
    if (this.state === "opening") {
      this.stopRequested = true;
    } else if (this.state === "recording") {
      this.recorder?.state === "inactive" ? this.finish() : this.recorder?.stop();
    }
    return this.result;
  }

  /** Discard whatever was captured. `stop()` resolves with an empty clip flagged `cancelled`. */
  cancel(): void {
    if (this.state === "stopped" || this.state === "cancelled") return;
    this.cancelled = true;
    this.chunks = [];
    if (this.state === "recording") {
      this.recorder?.state === "inactive" ? this.finish() : this.recorder?.stop();
    }
    // while "opening", begin() sees the flag and finishes without ever starting a recorder
  }

  /** @internal The mic went away underneath us. Whatever was captured is delivered. */
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
    if (this.stopRequested || this.cancelled) {
      // Released (or cancelled) during the prompt. An honest empty clip, mic left ready.
      this.finish();
      return;
    }
    if (!recorderSupported()) {
      this.fail(this.engine.fail(new AudioError("unsupported", "MediaRecorder is not available in this browser")));
      return;
    }

    this.ctx = this.engine.context;
    const recorder = this.mimeType ? new MediaRecorder(stream, { mimeType: this.mimeType }) : new MediaRecorder(stream);
    this.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && !this.cancelled) this.chunks.push(event.data);
    };
    recorder.onerror = () => this.fail(this.engine.fail(new AudioError("device_lost", "Recording failed mid-take")));
    recorder.onstop = () => this.finish();

    this.startedAt = this.ctx.currentTime;
    recorder.start();
    this.state = "recording";
    this.mic.transition("recording");

    const max = this.engine.options.take.maxDurationMs;
    if (max > 0) {
      this.limit = setTimeout(() => {
        this.engine.emit("take-limit", this);
        void this.stop();
      }, max);
    }
  }

  private finish(): void {
    if (this.state === "stopped" || this.state === "cancelled") return;
    this.clearLimit();
    const type = this.recorder?.mimeType || this.mimeType;
    const blob = this.cancelled ? new Blob([], { type }) : new Blob(this.chunks, { type });
    const durationMs = this.cancelled || !this.ctx ? 0 : Math.max(0, (this.ctx.currentTime - this.startedAt) * 1000);
    this.state = this.cancelled ? "cancelled" : "stopped";
    this.recorder = null;
    this.chunks = [];
    this.mic.release(this);
    this.resolveResult({ blob, mimeType: blob.type || type, durationMs, cancelled: this.cancelled });
  }

  private fail(error: AudioError): void {
    if (this.state === "stopped" || this.state === "cancelled") return;
    this.clearLimit();
    this.state = "stopped";
    this.recorder = null;
    this.chunks = [];
    this.mic.release(this);
    this.rejectResult(error);
  }

  private clearLimit(): void {
    if (this.limit) clearTimeout(this.limit);
    this.limit = null;
  }
}
