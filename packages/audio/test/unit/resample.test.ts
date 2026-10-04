import { describe, expect, test } from "bun:test";
import { createResampler, designLowpass, rms } from "../../src/dsp";

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function feed(r: ReturnType<typeof createResampler>, input: Float32Array, block = 128): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += block) parts.push(r.push(input.subarray(i, Math.min(i + block, input.length))));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Zero-crossing frequency estimate — good enough to tell 1 kHz from anything else. */
function frequency(samples: Float32Array, rate: number): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  return crossings / (samples.length / rate);
}

describe("designLowpass", () => {
  test("unity DC gain and symmetric", () => {
    const h = designLowpass(0.15, 31);
    expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    for (let i = 0; i < 15; i++) expect(h[i]).toBeCloseTo(h[30 - i], 8);
  });
});

describe("createResampler", () => {
  test("same rate passes through untouched", () => {
    const r = createResampler(48000, 48000);
    const input = sine(1000, 48000, 0.1);
    expect(r.push(input)).toBe(input);
  });

  test("48 kHz → 16 kHz keeps a 1 kHz tone: length, level, pitch", () => {
    const input = sine(1000, 48000, 0.5);
    const out = feed(createResampler(48000, 16000), input);
    expect(Math.abs(out.length - 8000)).toBeLessThanOrEqual(3);
    expect(rms(out)).toBeGreaterThan(rms(input) * 0.95);
    expect(rms(out)).toBeLessThan(rms(input) * 1.05);
    expect(Math.abs(frequency(out, 16000) - 1000)).toBeLessThan(30);
  });

  test("48 kHz → 16 kHz rejects a 20 kHz tone instead of folding it into the speech band", () => {
    const input = sine(20000, 48000, 0.5);
    const out = feed(createResampler(48000, 16000), input);
    expect(rms(out)).toBeLessThan(rms(input) * 0.03); // > 30 dB down
  });

  test("44.1 kHz → 16 kHz (a fractional ratio) is right too", () => {
    const input = sine(1000, 44100, 0.5);
    const out = feed(createResampler(44100, 16000), input);
    expect(Math.abs(out.length - 8000)).toBeLessThanOrEqual(3);
    expect(Math.abs(frequency(out, 16000) - 1000)).toBeLessThan(30);
  });

  test("block boundaries are seamless — 128-sample blocks match one big block", () => {
    const input = sine(700, 48000, 0.25);
    const blocked = feed(createResampler(48000, 16000), input, 128);
    const whole = feed(createResampler(48000, 16000), input, input.length);
    expect(blocked.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(blocked[i]).toBeCloseTo(whole[i], 5);
  });
});
