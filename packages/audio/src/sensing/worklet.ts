import { createResampler, designLowpass, follower } from "../dsp";
import { AudioError } from "../errors";
import { createEnergyVad } from "./energy-vad";
import { createVad } from "./vad-core";
import { createVadGate } from "./vad-gate";

export const CAPTURE_PROCESSOR = "patchwork-capture";

/** Main thread → worklet. */
export type ToWorklet =
  | { type: "stream"; on: boolean }
  | { type: "vad-options"; options: Record<string, number> }
  | { type: "terminate" };

/** Worklet → main thread. `t` is always audio-clock milliseconds. */
export type FromWorklet =
  | { type: "frame"; data: ArrayBuffer; t: number; speaking: boolean | null }
  | { type: "stream-end"; t: number }
  | { type: "vad"; t: number; speaking: boolean; level: number; threshold: number; noiseFloor: number }
  | { type: "vad-event"; event: "speech-start" | "speech-end" | "turn-end"; at: number; t: number };

/**
 * The AudioWorkletProcessor: mono-mix → resample to 16 kHz → 20 ms Int16
 * frames → VAD stage on every frame → frames over the port while a Stream
 * is subscribed. Runs on the audio thread, so it keeps going when
 * requestAnimationFrame is throttled in a hidden tab.
 */
const PROCESSOR = `
class PatchworkCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.targetRate = o.targetRate || 16000;
    this.frameLen = Math.max(1, Math.round((this.targetRate * (o.frameMs || 20)) / 1000));
    this.resampler = createResampler(sampleRate, this.targetRate);
    this.frame = new Int16Array(this.frameLen);
    this.fill = 0;
    this.streaming = false;
    this.terminated = false;
    this.vad = o.vad && o.vad.enabled ? createVad(o.vad) : null;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "stream") {
        if (this.streaming && !m.on) {
          if (this.fill > 0) this.onFrame(this.fill);
          this.port.postMessage({ type: "stream-end", t: currentTime * 1000 });
        }
        this.streaming = !!m.on;
      } else if (m.type === "vad-options" && this.vad) {
        this.vad.setOptions(m.options || {});
      } else if (m.type === "terminate") {
        this.terminated = true;
      }
    };
  }
  onFrame(length) {
    const t = currentTime * 1000;
    let speaking = null;
    if (this.vad) {
      const r = this.vad.process(this.frame.subarray(0, length), t);
      speaking = r.speaking;
      this.port.postMessage({ type: "vad", t, speaking: r.speaking, level: r.level, threshold: r.threshold, noiseFloor: r.noiseFloor });
      for (let i = 0; i < r.events.length; i++) {
        this.port.postMessage({ type: "vad-event", event: r.events[i].event, at: r.events[i].at, t });
      }
    }
    if (this.streaming) {
      const buf = this.frame.slice(0, length).buffer;
      this.port.postMessage({ type: "frame", data: buf, t, speaking }, [buf]);
    }
    this.fill = 0;
  }
  process(inputs) {
    if (this.terminated) return false;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    let mono = channels[0];
    if (channels.length > 1) {
      mono = new Float32Array(channels[0].length);
      for (let c = 0; c < channels.length; c++) {
        const ch = channels[c];
        for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / channels.length;
      }
    }
    const out = this.resampler.push(mono);
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      this.frame[this.fill++] = s <= -1 ? -32768 : s >= 1 ? 32767 : (s < 0 ? s * 32768 : s * 32767) | 0;
      if (this.fill === this.frameLen) this.onFrame(this.frameLen);
    }
    return true;
  }
}
registerProcessor("${CAPTURE_PROCESSOR}", PatchworkCapture);
`;

/**
 * The worklet's full source: the DSP and VAD functions the unit tests
 * exercise — stringified, not reimplemented — plus the processor. The audio
 * thread runs tested code, and a consumer needs no asset configuration.
 */
export function workletSource(): string {
  return [designLowpass, createResampler, follower, createEnergyVad, createVadGate, createVad]
    .map((fn) => fn.toString())
    .concat(PROCESSOR)
    .join("\n");
}

const loaded = new WeakMap<AudioContext, Promise<void>>();

/** Load the capture processor into a context once. Later calls share the promise. */
export function loadCaptureWorklet(ctx: AudioContext): Promise<void> {
  let pending = loaded.get(ctx);
  if (!pending) {
    if (!ctx.audioWorklet) {
      return Promise.reject(new AudioError("unsupported", "AudioWorklet is not available in this browser"));
    }
    const url = URL.createObjectURL(new Blob([workletSource()], { type: "text/javascript" }));
    pending = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loaded.set(ctx, pending);
  }
  return pending;
}
