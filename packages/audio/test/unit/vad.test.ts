import { describe, expect, test } from "bun:test";
import { createEnergyVad } from "../../src/sensing/energy-vad";
import { createVadGate } from "../../src/sensing/vad-gate";
import { createVad } from "../../src/sensing/vad-core";

/** An Int16 frame of uniform noise at a given RMS in dBFS. Deterministic. */
function frame(db: number, n = 320, seed = 1): Int16Array {
  const out = new Int16Array(n);
  const amp = Math.pow(10, db / 20) * Math.sqrt(12) * 32767;
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = Math.round((s / 0x100000000 - 0.5) * amp);
  }
  return out;
}

const DEFAULTS = { sensitivity: 0.5, minSpeechMs: 80, pauseMs: 300, turnEndMs: 900 };

describe("createEnergyVad — the stage", () => {
  function settle(stage: ReturnType<typeof createEnergyVad>, db: number, frames: number, t0 = 0, speaking = false) {
    let r = stage.process(frame(db), t0, speaking);
    for (let i = 1; i < frames; i++) r = stage.process(frame(db, 320, i), t0 + i * 20, speaking);
    return r;
  }

  test("the noise floor adopts a quieter room quickly and a louder one slowly", () => {
    const stage = createEnergyVad(0.5);
    expect(settle(stage, -60, 60).noiseFloor).toBeCloseTo(-60, 0);
    expect(settle(stage, -80, 50, 1200).noiseFloor).toBeLessThan(-77); // down in ~1 s
    expect(settle(stage, -50, 50, 2200).noiseFloor).toBeLessThan(-58); // still low after 1 s of louder noise
    expect(settle(stage, -50, 500, 3200).noiseFloor).toBeGreaterThan(-54); // adopted after ~10 s (τ = 4 s)
  });

  test("sensitivity is a margin above the floor: 12 dB at 0.5, 4 dB at 1, 20 dB at 0", () => {
    const stage = createEnergyVad(0.5);
    settle(stage, -60, 60);
    expect(settle(stage, -50, 5, 1200, true).loud).toBe(false); // +10 dB, under a 12 dB margin
    expect(settle(stage, -45, 5, 1300, true).loud).toBe(true); // +15 dB
    stage.setSensitivity(1);
    expect(settle(stage, -55, 5, 1400, true).loud).toBe(true); // +5 dB clears a 4 dB margin
    stage.setSensitivity(0);
    expect(settle(stage, -45, 5, 1500, true).loud).toBe(false); // +15 dB under a 20 dB margin
    expect(settle(stage, -38, 5, 1600, true).loud).toBe(true);
  });

  test("an absolute minimum keeps digital silence from making −75 dB count as speech", () => {
    const stage = createEnergyVad(1);
    settle(stage, -100, 60); // dead silence; floor pinned at −100, margin only 4 dB
    expect(settle(stage, -75, 5, 1200, true).loud).toBe(false);
    expect(settle(stage, -60, 5, 1300, true).loud).toBe(true);
  });

  test("the floor does not chase speech", () => {
    const stage = createEnergyVad(0.5);
    settle(stage, -60, 60);
    const r = settle(stage, -30, 150, 1200, true); // 3 s of talking, with the gate saying so
    expect(r.noiseFloor).toBeCloseTo(-60, 0);
    expect(r.loud).toBe(true);
  });

  test("level and threshold share one 0..1 scale, 40 dB above the floor being 1", () => {
    const stage = createEnergyVad(0.5);
    settle(stage, -60, 60);
    const r = settle(stage, -40, 6, 1200, true);
    expect(r.level).toBeCloseTo(0.5, 1);
    expect(r.threshold).toBeCloseTo(0.3, 1); // 12 dB / 40 dB
  });
});

describe("createVadGate — the two silences", () => {
  type Step = [loud: boolean, ms: number];
  function run(steps: Step[], dt: number, opts = DEFAULTS) {
    const gate = createVadGate(opts);
    const events: { event: string; at: number; t: number }[] = [];
    let t = 0;
    for (const [loud, ms] of steps) {
      const end = t + ms;
      for (; t < end - 1e-9; t += dt) for (const e of gate.update(loud, t)) events.push({ ...e, t });
    }
    return events;
  }

  test("a blip shorter than minSpeechMs is ignored; real speech starts at its onset", () => {
    expect(run([[true, 60], [false, 500]], 20)).toEqual([]);
    const [start] = run([[true, 100], [false, 500]], 20);
    expect(start).toMatchObject({ event: "speech-start", at: 0 });
    expect(start.t).toBe(80);
  });

  test("a gap shorter than pauseMs is bridged; a longer one ends the utterance at the silence's start", () => {
    const events = run([[true, 300], [false, 200], [true, 300], [false, 400]], 20);
    expect(events.map((e) => [e.event, e.at])).toEqual([
      ["speech-start", 0],
      ["speech-end", 800],
    ]);
    expect(events[1].t).toBe(1100); // confirmed exactly pauseMs after the silence began
  });

  test("turn-end fires once, turnEndMs into the silence, and not if speech resumes first", () => {
    const events = run([[true, 300], [false, 1200]], 20);
    expect(events.map((e) => [e.event, e.at, e.t])).toEqual([
      ["speech-start", 0, 80],
      ["speech-end", 300, 600],
      ["turn-end", 300, 1200],
    ]);

    const resumed = run([[true, 300], [false, 400], [true, 300], [false, 1200]], 20);
    expect(resumed.map((e) => [e.event, e.at])).toEqual([
      ["speech-start", 0],
      ["speech-end", 300],
      ["speech-start", 700],
      ["speech-end", 1000],
      ["turn-end", 1000], // one turn, ended once
    ]);
  });

  test("timing is the same at any frame rate", () => {
    const steps: Step[] = [[false, 200], [true, 500], [false, 200], [true, 250], [false, 1300]];
    const at60 = run(steps, 1000 / 60);
    const at120 = run(steps, 1000 / 120);
    const at30 = run(steps, 1000 / 30);
    expect(at60.map((e) => e.event)).toEqual(at120.map((e) => e.event));
    expect(at60.map((e) => e.event)).toEqual(at30.map((e) => e.event));
    for (let i = 0; i < at60.length; i++) {
      expect(Math.abs(at60[i].at - at120[i].at)).toBeLessThanOrEqual(1000 / 60 + 0.01);
      expect(Math.abs(at60[i].at - at30[i].at)).toBeLessThanOrEqual(1000 / 30 + 0.01);
    }
  });
});

describe("createVad — stage + gate on audio", () => {
  function scenario(dt: number) {
    const vad = createVad(DEFAULTS);
    const events: { event: string; at: number; t: number }[] = [];
    const n = Math.round(dt * 16);
    let i = 0;
    for (let t = 0; t < 3500; t += dt, i++) {
      const db = t >= 1000 && t < 2000 ? -30 : -70;
      for (const e of vad.process(frame(db, n, i), t).events) events.push({ ...e, t });
    }
    return events;
  }

  test("1 s of speech over room noise: start ≈ 1000, end ≈ 2000, turn-end 900 ms later — at 30, 60 and 120 Hz", () => {
    for (const dt of [1000 / 30, 1000 / 60, 1000 / 120]) {
      const events = scenario(dt);
      expect(events.map((e) => e.event)).toEqual(["speech-start", "speech-end", "turn-end"]);
      const [start, end, turn] = events;
      expect(Math.abs(start.at - 1000)).toBeLessThan(dt + 40);
      expect(Math.abs(end.at - 2000)).toBeLessThan(dt + 80);
      expect(turn.at).toBe(end.at);
      // The lag is the option, not the option plus a hidden smoother: 0.1.0 measured 533 ms against a 280 ms setting.
      expect(end.t - end.at).toBeGreaterThanOrEqual(300);
      expect(end.t - end.at).toBeLessThan(300 + dt + 1);
      expect(turn.t - turn.at).toBeGreaterThanOrEqual(900);
      expect(turn.t - turn.at).toBeLessThan(900 + dt + 1);
    }
  });
});
