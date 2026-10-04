import type { VadOptions } from "../types";
import { CAPTURE_PROCESSOR, type FromWorklet, type ToWorklet, loadCaptureWorklet } from "./worklet";

export type StreamMessage = Extract<FromWorklet, { type: "frame" | "stream-end" }>;
export type VadMessage = Extract<FromWorklet, { type: "vad" | "vad-event" }>;

/**
 * The mic's worklet node: one per open microphone, shared by the VAD (always
 * on while the mic is open, if enabled) and by a pcm16k Stream (subscribes
 * and unsubscribes). Owned by Mic; disposed on close or loss.
 */
export class Capture {
  private stream: ((message: StreamMessage) => void) | null = null;

  private constructor(
    private readonly source: MediaStreamAudioSourceNode,
    private readonly node: AudioWorkletNode,
    private readonly sink: GainNode,
  ) {}

  static async create(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    vad: (VadOptions & { enabled: boolean }) | null,
    onVad: (message: VadMessage) => void,
  ): Promise<Capture> {
    await loadCaptureWorklet(ctx);
    const node = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: 16000, frameMs: 20, vad },
    });
    // A dangling worklet is not guaranteed to be rendered: give it a silent path to the destination.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    const capture = new Capture(source, node, sink);
    node.port.onmessage = (event: MessageEvent<FromWorklet>) => {
      const message = event.data;
      if (message.type === "frame" || message.type === "stream-end") capture.stream?.(message);
      else onVad(message);
    };
    return capture;
  }

  /** Route frames to a Stream and tell the worklet to start posting them. */
  startStream(handler: (message: StreamMessage) => void): void {
    this.stream = handler;
    this.post({ type: "stream", on: true });
  }

  /** The worklet flushes its partial frame and answers `stream-end`. */
  stopStream(): void {
    this.post({ type: "stream", on: false });
  }

  clearStream(): void {
    this.stream = null;
  }

  setVadOptions(options: Partial<VadOptions>): void {
    this.post({ type: "vad-options", options: options as Record<string, number> });
  }

  dispose(): void {
    this.post({ type: "terminate" });
    this.node.port.onmessage = null;
    this.stream = null;
    try { this.source.disconnect(this.node); } catch { /* already gone */ }
    this.node.disconnect();
    this.sink.disconnect();
  }

  private post(message: ToWorklet): void {
    try { this.node.port.postMessage(message); } catch { /* port closed */ }
  }
}
