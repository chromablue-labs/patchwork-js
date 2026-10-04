import { follower } from "../dsp";
import type { VadReading, VadStage } from "../types";

/**
 * Adaptive-energy voice detector — the v1 `VadStage`.
 *
 * Works in dBFS. The envelope chases frame RMS with fast attack / short
 * release. The noise floor chases the envelope only while nobody is
 * speaking, falling quickly (a quieter room is adopted in ~300 ms) and
 * rising slowly (a brief noise cannot lift it). `sensitivity` sets the
 * threshold as a margin above the floor — 20 dB at 0, 4 dB at 1 — with an
 * absolute minimum so digital silence cannot make −75 dB count as speech.
 * `level` and `threshold` are reported on one 0..1 scale, 40 dB above the
 * floor being 1, so a UI can draw them against each other.
 *
 * Plain function, ES2020 only — stringified into the AudioWorklet. It may
 * reference only its arguments and `follower`.
 */
export function createEnergyVad(sensitivity: number): VadStage {
  const MIN_DB = -100;
  const ATTACK_MS = 10;
  const RELEASE_MS = 50;
  const FLOOR_DOWN_MS = 300;
  const FLOOR_UP_MS = 4000;
  const FLOOR_MAX_DB = -20;
  const ABS_MIN_DB = -65;
  const RANGE_DB = 40;

  let margin = 20 - 16 * sensitivity;
  let env = MIN_DB;
  let floor = MIN_DB;
  let hasFloor = false;
  let lastT = -1;

  return {
    setSensitivity(value: number): void {
      margin = 20 - 16 * Math.min(1, Math.max(0, value));
    },
    process(frame: ArrayLike<number>, t: number, speaking: boolean): VadReading {
      const n = frame.length;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += frame[i] * frame[i];
      const scale = frame instanceof Int16Array ? 32768 : 1;
      const rms = n > 0 ? Math.sqrt(sum / n) / scale : 0;
      const db = rms > 0 ? Math.max(MIN_DB, 20 * Math.log10(rms)) : MIN_DB;

      const dt = lastT < 0 ? 20 : Math.max(0, t - lastT);
      lastT = t;

      if (!hasFloor) {
        // The first frame has no history to smooth: seed both from the reading itself.
        env = db;
        floor = db;
        hasFloor = true;
      } else {
        env = follower(env, db, dt, ATTACK_MS, RELEASE_MS);
      }
      if (!speaking && lastT >= 0 && dt > 0) {
        // follower(prev, next, dt, attackMs, releaseMs): attack is the RISING constant — slow up, fast down.
        floor = follower(floor, env, dt, FLOOR_UP_MS, FLOOR_DOWN_MS);
      }
      if (floor > FLOOR_MAX_DB) floor = FLOOR_MAX_DB;

      const thresholdDb = Math.max(floor + margin, ABS_MIN_DB);
      const level = Math.min(1, Math.max(0, (env - floor) / RANGE_DB));
      const threshold = Math.min(1, Math.max(0, (thresholdDb - floor) / RANGE_DB));
      return { loud: env >= thresholdDb, level, threshold, noiseFloor: floor, levelDb: env };
    },
  };
}
