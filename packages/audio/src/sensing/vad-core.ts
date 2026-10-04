import type { VadEventName, VadOptions, VadStage } from "../types";
import { createEnergyVad } from "./energy-vad";
import { createVadGate } from "./vad-gate";

export type VadFrameResult = {
  speaking: boolean;
  level: number;
  threshold: number;
  noiseFloor: number;
  events: { event: VadEventName; at: number }[];
};

/**
 * The whole detector for one frame: stage → loud, gate → events. The stage
 * is pluggable behind `VadStage`; energy is the v1 stage. Plain function —
 * stringified into the AudioWorklet along with the two it calls.
 */
export function createVad(options: VadOptions, stage?: VadStage): {
  readonly speaking: boolean;
  setOptions(patch: Partial<VadOptions>): void;
  process(frame: ArrayLike<number>, t: number): VadFrameResult;
  reset(): void;
} {
  const s = stage ?? createEnergyVad(options.sensitivity);
  const gate = createVadGate(options);
  return {
    get speaking() {
      return gate.speaking;
    },
    setOptions(patch) {
      if (patch.sensitivity !== undefined) s.setSensitivity(patch.sensitivity);
      gate.setOptions(patch);
    },
    process(frame, t) {
      const reading = s.process(frame, t, gate.speaking);
      const events = gate.update(reading.loud, t);
      return { speaking: gate.speaking, level: reading.level, threshold: reading.threshold, noiseFloor: reading.noiseFloor, events };
    },
    reset() {
      gate.reset();
    },
  };
}
