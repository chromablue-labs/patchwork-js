import { describe, expect, test } from "bun:test";
import { clamp01, peak, rms } from "../../src/dsp";

describe("rms", () => {
  test("empty is zero", () => expect(rms([])).toBe(0));
  test("silence is zero", () => expect(rms([0, 0, 0, 0])).toBe(0));
  test("full-scale square wave is 1", () => expect(rms([1, -1, 1, -1])).toBeCloseTo(1));
  test("half-scale is 0.5", () => expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5));
  test("a lone click barely registers", () => {
    const window = new Float32Array(2048);
    window[100] = 1;
    expect(rms(window)).toBeLessThan(0.03);
  });
});

describe("peak", () => {
  test("tracks the loudest sample", () => expect(peak([0.1, -0.8, 0.2])).toBeCloseTo(0.8));
  test("a lone click is a full peak", () => {
    const window = new Float32Array(2048);
    window[100] = 1;
    expect(peak(window)).toBe(1);
  });
});

describe("clamp01", () => {
  test("bounds the range", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(4)).toBe(1);
  });
  test("NaN and infinities clamp to 0 instead of poisoning the meter", () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
  });
});
