import type { Engine } from "../engine";
import { AudioError, fromBrowserError } from "../errors";
import { Capture } from "../sensing/capture";
import { Stream } from "../transport/stream";
import { Take } from "../transport/take";
import type { MicState, StreamOptions } from "../types";

/** What the mic tracks while a Take or Stream owns it. Generic-free on purpose (Stream<F> is invariant). */
type Owner = { abort(): void };
type CaptureNode = Capture;

const OPEN_STATES: ReadonlySet<MicState> = new Set(["ready", "recording", "streaming"]);
const LISTENING_STATES: ReadonlySet<MicState> = new Set(["recording", "streaming"]);

function mediaDevices(): MediaDevices | null {
  if (typeof navigator === "undefined") return null;
  const md = navigator.mediaDevices;
  return md && typeof md.getUserMedia === "function" ? md : null;
}

/**
 * The microphone as a state machine. Presence, permission, readiness, loss
 * and interruption are states a UI can render — not exceptions to catch.
 *
 *   unavailable | idle → requesting → ready ⇄ recording | streaming
 *                                   ↘ denied           ↘ lost
 */
export class Mic {
  state: MicState;
  mediaStream: MediaStream | null = null;

  private inputs: MediaDeviceInfo[] = [];
  private opening: Promise<MediaStream> | null = null;
  private active: Owner | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  /** @internal The worklet node — the VAD's home and the pcm16k Stream's source. One per open mic. */
  captureNode: CaptureNode | null = null;
  private capturing: Promise<CaptureNode> | null = null;
  private readonly onDeviceChange = (): void => {
    void this.refreshDevices(true);
  };

  constructor(private readonly engine: Engine) {
    const md = mediaDevices();
    this.state = md ? "idle" : "unavailable";
    if (md) {
      md.addEventListener("devicechange", this.onDeviceChange);
      void this.refreshDevices(false);
    }
  }

  /** A capture device exists. Populated by enumerateDevices — await `devices()` if you read this right after construction. */
  get isPresent(): boolean {
    return this.inputs.length > 0;
  }
  /** Permission granted and the stream is open. */
  get isReady(): boolean {
    return OPEN_STATES.has(this.state);
  }
  /** A Take or a Stream is in progress. */
  get isListening(): boolean {
    return LISTENING_STATES.has(this.state);
  }

  /** Audio input devices. Labels are empty until permission has been granted once. */
  async devices(): Promise<MediaDeviceInfo[]> {
    await this.refreshDevices(false);
    return this.inputs.slice();
  }

  /** What the browser actually granted — sample rate, channel count, whether AEC applied. */
  settings(): MediaTrackSettings | null {
    const track = this.mediaStream?.getAudioTracks()[0];
    return track ? track.getSettings() : null;
  }

  /**
   * Open the microphone. Idempotent while ready; concurrent calls share one
   * request. Constraints deep-merge over the engine's `audio` defaults, so
   * picking a device never switches echo cancellation off.
   *
   * `stream` hands in a MediaStream you already hold (a call, a synthetic
   * source, a test) instead of asking `getUserMedia`; everything downstream —
   * sensing, streaming, takes, levels, device loss — treats it as the mic.
   */
  async open(opts: { device?: string; stream?: MediaStream } = {}): Promise<MediaStream> {
    this.engine.assertOpen();
    if (this.mediaStream && this.isReady) {
      // Idempotent for the same request; a different stream or device replaces the open one.
      const sameStream = opts.stream ? opts.stream === this.mediaStream : true;
      const sameDevice = opts.device ? opts.device === this.settings()?.deviceId : true;
      if (sameStream && sameDevice) return this.mediaStream;
      this.close();
    }
    if (this.opening) return this.opening;

    const md = mediaDevices();
    if (!md && !opts.stream) {
      this.set("unavailable");
      throw this.engine.fail(new AudioError("unsupported", "This browser cannot open a microphone"));
    }

    this.opening = (async () => {
      await this.engine.unlock(); // throws not_unlocked outside a gesture; state stays as it was
      this.set("requesting");

      let stream: MediaStream;
      if (opts.stream) {
        if (opts.stream.getAudioTracks().length === 0) {
          this.set("unavailable");
          throw this.engine.fail(new AudioError("no_microphone", "The supplied MediaStream has no audio track"));
        }
        stream = opts.stream;
      } else {
        const audio: MediaTrackConstraints = { ...this.engine.options.audio };
        if (opts.device) audio.deviceId = { exact: opts.device };
        try {
          stream = await (md as MediaDevices).getUserMedia({ audio });
        } catch (err) {
          const error = fromBrowserError(err, "no_microphone");
          this.set(error.code === "permission_denied" ? "denied" : "unavailable");
          throw this.engine.fail(error);
        }
      }

      if (this.engine.state === "closed") {
        for (const track of stream.getTracks()) track.stop();
        throw this.engine.fail(new AudioError("engine_closed", "The engine was closed while the microphone was opening"));
      }

      this.attach(stream);
      if (this.engine.vad.enabled) {
        // Sensing runs whenever the mic is open. If the worklet cannot load, the mic still works — say so, once.
        try {
          await this.capture();
        } catch (err) {
          this.engine.fail(fromBrowserError(err, "unsupported"));
        }
      }
      this.set("ready");
      void this.refreshDevices(false); // labels populate once permission is granted
      return stream;
    })().finally(() => {
      this.opening = null;
    });

    return this.opening;
  }

  /**
   * Start a push-to-talk take. Returns a handle synchronously — during the
   * permission prompt, during `open()`, whenever — so `stop()` can never be
   * lost to a race. Throws if a take or a stream is already in progress.
   */
  record(): Take {
    this.engine.assertOpen();
    this.assertFree();
    const take = new Take(this.engine, this);
    this.active = take;
    return take;
  }

  /** Start live capture. `pcm16k` (default) frames are each complete; `opus` chunks are cumulative. */
  stream(opts: { format: "pcm16k"; timesliceMs?: number }): Stream<Int16Array>;
  stream(opts: { format: "opus"; timesliceMs?: number }): Stream<Blob>;
  stream(opts?: StreamOptions): Stream<Int16Array> | Stream<Blob>;
  stream(opts: StreamOptions = {}): Stream<Int16Array> | Stream<Blob> {
    this.engine.assertOpen();
    this.assertFree();
    const defaults = this.engine.options.stream;
    const stream = new Stream(this.engine, this, {
      format: opts.format ?? defaults.format,
      timesliceMs: opts.timesliceMs ?? defaults.timesliceMs,
    });
    this.active = stream;
    // Stream<F> is invariant in F; the overloads above are the typed surface.
    return stream as unknown as Stream<Int16Array> | Stream<Blob>;
  }

  /** @internal The graph node for the open stream — one per stream, shared by every consumer. */
  sourceNode(): MediaStreamAudioSourceNode {
    if (!this.mediaStream) throw this.engine.fail(new AudioError("device_lost", "The microphone is not open"));
    if (!this.source) this.source = this.engine.context.createMediaStreamSource(this.mediaStream);
    return this.source;
  }

  /** @internal The worklet node for the open mic, created on first need and shared. */
  capture(): Promise<CaptureNode> {
    if (this.captureNode) return Promise.resolve(this.captureNode);
    if (this.capturing) return this.capturing;
    const source = this.sourceNode();
    this.capturing = Capture.create(this.engine.context, source, this.engine.vad.processorOptions(), (m) => this.engine.vad.handle(m))
      .then((node) => {
        if (!this.mediaStream) {
          node.dispose();
          throw new AudioError("device_lost", "The microphone closed while its capture node was starting");
        }
        this.captureNode = node;
        return node;
      })
      .finally(() => {
        this.capturing = null;
      });
    return this.capturing;
  }

  /** @internal A Take or Stream has finished; the mic is free again. */
  release(owner: Owner): void {
    if (this.active !== owner) return;
    this.active = null;
    if (this.state === "recording" || this.state === "streaming") this.set(this.mediaStream ? "ready" : "idle");
    if (owner instanceof Take && this.engine.options.take.closeAfterTake) this.close();
  }

  private assertFree(): void {
    if (this.active instanceof Take) throw this.engine.fail(new AudioError("take_in_progress", "A take is already in progress; stop() or cancel() it first"));
    if (this.active instanceof Stream) throw this.engine.fail(new AudioError("stream_in_progress", "A stream is live; stop() it first"));
  }

  /** Stop the tracks. The recording indicator goes off. `open()` again to resume. */
  close(): void {
    this.active?.abort();
    this.disposeCapture();
    this.disposeSource();
    const stream = this.mediaStream;
    this.mediaStream = null;
    if (stream) {
      // Detach before stopping: our own stop must never read as device loss.
      for (const track of stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
    }
    if (this.state !== "unavailable") this.set("idle");
  }

  /** @internal Take and Stream mark the mic busy through this; `release()` frees it. */
  transition(state: MicState): void {
    this.set(state);
  }

  private attach(stream: MediaStream): void {
    this.mediaStream = stream;
    for (const track of stream.getAudioTracks()) {
      track.onended = () => this.lost();
    }
  }

  private lost(): void {
    const stream = this.mediaStream;
    if (!stream) return;
    this.mediaStream = null;
    for (const track of stream.getTracks()) track.onended = null;
    this.active?.abort();
    this.disposeCapture();
    this.disposeSource();
    this.set("lost");
    this.engine.fail(
      new AudioError("device_lost", "The microphone stopped — unplugged, revoked, or taken by another app. Call mic.open() to try again."),
    );
  }

  private disposeCapture(): void {
    const node = this.captureNode;
    if (!node) return;
    this.captureNode = null;
    let now = 0;
    try { now = this.engine.context.currentTime * 1000; } catch { /* closing */ }
    node.dispose();
    this.engine.vad.reset(now);
  }

  private disposeSource(): void {
    try { this.source?.disconnect(); } catch { /* already disconnected */ }
    this.source = null;
  }

  private async refreshDevices(announce: boolean): Promise<void> {
    const md = mediaDevices();
    if (!md || typeof md.enumerateDevices !== "function") return;
    try {
      const all = await md.enumerateDevices();
      this.inputs = all.filter((d) => d.kind === "audioinput");
      if (announce) this.engine.emit("devices", this.inputs.slice());
    } catch {
      // enumerateDevices can reject in unusual contexts; presence simply stays unknown
    }
  }

  private set(state: MicState): void {
    if (state === this.state) return;
    this.state = state;
    this.engine.emit("mic", state);
  }
}
