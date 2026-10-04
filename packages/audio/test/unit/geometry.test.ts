import { describe, expect, test } from "bun:test";
import { barGeometry, orbGeometry } from "../../src/display/geometry";
import { levelFromRms } from "../../src/dsp";
import { validateLevelsOptions } from "../../src/options";

const bars = Float32Array.from([0, 0.25, 0.5, 1]);
const still = { bars, hopProgress: 0, level: 0.8 };

describe("levelFromRms", () => {
  test("maps −50 dBFS → 0, −20 dBFS → 0.6, 0 dBFS → 1, silence → 0", () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(Math.pow(10, -50 / 20))).toBeCloseTo(0);
    expect(levelFromRms(Math.pow(10, -20 / 20))).toBeCloseTo(0.6);
    expect(levelFromRms(1)).toBe(1);
    expect(levelFromRms(2)).toBe(1);
    expect(levelFromRms(Number.NaN)).toBe(0);
  });
});

describe("barGeometry", () => {
  test("fixed slots: newest at the entry edge, heights from the values, dots never vanish", () => {
    const g = barGeometry(still, 100, 50, { gap: 2, mirrored: true });
    expect(g).toHaveLength(4);
    const newest = g[g.length - 1];
    expect(newest.v).toBe(1);
    expect(newest.x).toBeCloseTo(1); // slot 0 + gap/2
    expect(newest.h).toBe(50);
    expect(newest.y).toBe(0);
    const oldest = g[0];
    expect(oldest.v).toBe(0);
    expect(oldest.h).toBe(oldest.w); // a dot
    expect(oldest.y).toBeCloseTo((50 - oldest.w) / 2);
    expect(oldest.x).toBeCloseTo(76);
  });

  test("enterFrom right mirrors x; mirrored:false sits on the baseline", () => {
    const g = barGeometry(still, 100, 50, { gap: 0, enterFrom: "right", mirrored: false, minHeight: 0 });
    expect(g[g.length - 1].x).toBeCloseTo(75);
    expect(g[0].x).toBeCloseTo(0);
    const half = g.find((b) => b.v === 0.5) as { y: number; h: number };
    expect(half.h).toBe(25);
    expect(half.y).toBe(25);
  });

  test("count takes the most recent slots", () => {
    const g = barGeometry(still, 100, 50, { count: 2 });
    expect(g.map((b) => b.v)).toEqual([0.5, 1]);
  });

  test("glide adds the live bar and offsets everything by hopProgress; reduced motion turns it off", () => {
    const glide = barGeometry({ ...still, hopProgress: 0.5 }, 100, 50, { glide: true, gap: 0 });
    expect(glide).toHaveLength(5);
    expect(glide[glide.length - 1].v).toBe(0.8); // the live level, entering
    expect(glide[glide.length - 1].x).toBeCloseTo(-12.5); // half a slot off the edge
    expect(glide[glide.length - 2].x).toBeCloseTo(12.5);
    const fixed = barGeometry({ ...still, hopProgress: 0.5 }, 100, 50, { glide: true, gap: 0, reducedMotion: true });
    expect(fixed).toHaveLength(4);
    expect(fixed[fixed.length - 1].x).toBe(0);
  });

  test("radius never exceeds half the bar", () => {
    const g = barGeometry(still, 100, 50, { radius: 100 });
    for (const b of g) expect(b.r).toBeLessThanOrEqual(Math.min(b.w, b.h) / 2 + 1e-9);
  });
});

const quiet = { level: 0, peak: 0, mic: { rms: 0, peak: 0, level: 0 }, player: { rms: 0, peak: 0, level: 0 } };

describe("orbGeometry", () => {
  test("radius grows with level between minRadius and the box", () => {
    const silent = orbGeometry({ t: 0, ...quiet }, 200, 100, { idleBreath: false });
    const loud = orbGeometry({ t: 0, ...quiet, level: 1 }, 200, 100);
    expect(silent.cx).toBe(100);
    expect(silent.cy).toBe(50);
    expect(silent.r).toBeCloseTo(45 * 0.55);
    expect(loud.r).toBeCloseTo(45);
    expect(loud.breath).toBe(0);
  });

  test("breathes only when idle, on the audio clock, and not under reduced motion", () => {
    const at = (t: number, opts = {}) => orbGeometry({ t, ...quiet }, 200, 200, opts).breath;
    expect(at(0)).toBeCloseTo(0);
    expect(at(1000)).toBeGreaterThan(0); // a quarter period in
    expect(at(3000)).toBeLessThan(0);
    expect(at(1000, { reducedMotion: true })).toBe(0);
    expect(at(1000, { idleBreath: false })).toBe(0);
    expect(orbGeometry({ t: 1000, ...quiet, level: 0.5 }, 200, 200).breath).toBe(0);
  });

  test("hue follows who is louder", () => {
    const mic = orbGeometry({ t: 0, ...quiet, level: 0.5, mic: { rms: 0, peak: 0, level: 0.5 } }, 100, 100);
    const player = orbGeometry({ t: 0, ...quiet, level: 0.5, player: { rms: 0, peak: 0, level: 0.5 } }, 100, 100);
    const both = orbGeometry({ t: 0, ...quiet, level: 0.5, mic: { rms: 0, peak: 0, level: 0.5 }, player: { rms: 0, peak: 0, level: 0.5 } }, 100, 100);
    expect(mic).toMatchObject({ hue: 200, who: "mic" });
    expect(player).toMatchObject({ hue: 280, who: "player" });
    expect(both.hue).toBe(240);
    expect(orbGeometry({ t: 0, ...quiet }, 100, 100).who).toBe("none");
  });

  test("glow follows the peak, logarithmically", () => {
    const g = (peak: number) => orbGeometry({ t: 0, ...quiet, peak }, 100, 100).glow;
    expect(g(0)).toBe(4);
    expect(g(1)).toBe(28);
    expect(g(0.1)).toBeCloseTo(4 + 24 * 0.6);
  });
});

describe("validateLevelsOptions", () => {
  const ok = { historyMs: 700, hopMs: 16, attackMs: 40, releaseMs: 120, fftSize: 2048 };
  test("accepts the defaults and rejects the usual mistakes", () => {
    expect(validateLevelsOptions(ok)).toEqual(ok);
    expect(() => validateLevelsOptions({ ...ok, fftSize: 1000 })).toThrow(/power of two/);
    expect(() => validateLevelsOptions({ ...ok, hopMs: 0 })).toThrow(/greater than 0/);
    expect(() => validateLevelsOptions({ ...ok, historyMs: 8 })).toThrow(/at least levels.hopMs/);
    expect(() => validateLevelsOptions({ ...ok, attackMs: -1 })).toThrow(/non-negative/);
  });
});
