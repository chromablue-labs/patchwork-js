import type { Engine } from "../engine";
import { Emitter } from "../events";
import { validateVadOptions } from "../options";
import type { VadEvents, VadOptions } from "../types";
import type { VadMessage } from "./capture";

/**
 * Sensing — *is a human talking, and did they just stop?*
 *
 * Reads only the microphone tap, on the audio thread, so playback can never
 * trip it and a hidden tab cannot freeze it. `speaking`, `level`,
 * `threshold` and `noiseFloor` mirror the worklet's latest frame; the three
 * events carry `at`, the audio-clock millisecond the thing happened.
 */
export class Vad {
  /** Set from options at creation. `false` means no VAD stage runs at all. */
  readonly enabled: boolean;
  speaking = false;
  /** 0..1 above the noise floor; 40 dB above is 1. */
  level = 0;
  /** Where `level` must reach to count as loud, on the same 0..1 scale. */
  threshold = 0;
  /** Current ambient estimate, dBFS. */
  noiseFloor = -100;

  private opts: VadOptions;
  private readonly bus = new Emitter<VadEvents>();

  /** @internal */
  constructor(private readonly engine: Engine) {
    const { enabled, ...timing } = engine.options.vad;
    this.enabled = enabled;
    this.opts = timing;
  }

  get options(): Readonly<VadOptions> {
    return this.opts;
  }

  /** Update any subset live; the worklet picks it up on its next frame. Validated like `createEngine`. */
  set options(patch: Partial<VadOptions>) {
    const next = validateVadOptions({ ...this.opts, ...patch });
    this.opts = next;
    this.engine.mic.captureNode?.setVadOptions(next);
  }

  on<K extends keyof VadEvents>(event: K, fn: (payload: VadEvents[K]) => void): () => void {
    return this.bus.on(event, fn);
  }

  /** @internal Processor options for a new capture node. */
  processorOptions(): (VadOptions & { enabled: boolean }) | null {
    return this.enabled ? { enabled: true, ...this.opts } : null;
  }

  /** @internal */
  handle(message: VadMessage): void {
    if (message.type === "vad") {
      this.speaking = message.speaking;
      this.level = message.level;
      this.threshold = message.threshold;
      this.noiseFloor = message.noiseFloor;
      return;
    }
    this.bus.emit(message.event, { at: message.at, t: message.t });
  }

  /** @internal The mic closed or was lost. If we were mid-speech, that speech has ended. */
  reset(t: number): void {
    const wasSpeaking = this.speaking;
    this.speaking = false;
    this.level = 0;
    if (wasSpeaking) this.bus.emit("speech-end", { at: t, t });
  }

  /** @internal */
  clear(): void {
    this.bus.clear();
  }
}
