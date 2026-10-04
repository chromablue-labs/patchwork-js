import { describe, expect, test } from "bun:test";
import { createHistory, slotCount } from "../../src/display/history";

/** A level that changes over time — a syllable-ish pulse train — sampled at any call rate. */
const signal = (tMs: number) => (Math.sin((2 * Math.PI * tMs) / 250) > 0 ? 0.7 : 0.1);

function run(hz: number, durationMs = 2000, historyMs = 700, hopMs = 16) {
  const h = createHistory(historyMs, hopMs);
  const step = 1000 / hz;
  for (let t = 0; t <= durationMs; t += step) h.tick(signal(t), t);
  return h;
}

describe("createHistory — the time-based strip", () => {
  test("slot count is historyMs / hopMs", () => {
    expect(slotCount(700, 16)).toBe(44);
    expect(slotCount(1000, 50)).toBe(20);
    expect(createHistory(700, 16).bars.length).toBe(44);
  });

  test("30, 60 and 120 Hz callers see the same 0.7 s", () => {
    const a = run(30).bars;
    const b = run(60).bars;
    const c = run(120).bars;
    expect(a.length).toBe(b.length);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]), Math.abs(a[i] - c[i]));
    // A slot that straddles a signal edge may land on either side at one rate and
    // not another; the signal has six edges in the window and the strip is otherwise identical.
    const differing = [...a].filter((v, i) => Math.abs(v - b[i]) > 0.01 || Math.abs(v - c[i]) > 0.01).length;
    expect(differing).toBeLessThanOrEqual(6);
    expect(worst).toBeLessThanOrEqual(0.6);
  });

  test("a slot holds the loudest level seen during its hop, not the last", () => {
    const h = createHistory(160, 16);
    h.tick(0.1, 0);
    h.tick(0.9, 5);
    h.tick(0.1, 10);
    h.tick(0.1, 16); // hop turns over
    expect(h.bars[h.bars.length - 1]).toBeCloseTo(0.9);
  });

  test("hops nobody observed (a throttled tab) fill with the level found on waking", () => {
    const h = createHistory(160, 16);
    h.tick(0.2, 0);
    h.tick(0.8, 100); // ~6 hops elapsed
    const bars = [...h.bars];
    const want = [0.2, 0.8, 0.8, 0.8, 0.8, 0.8];
    bars.slice(-6).forEach((v, i) => expect(v).toBeCloseTo(want[i], 5));
    expect(bars.slice(0, 4)).toEqual([0, 0, 0, 0]);
  });

  test("progress runs 0..1 through the hop on the clock", () => {
    const h = createHistory(160, 16);
    h.tick(0, 0);
    h.tick(0, 4);
    expect(h.progress).toBeCloseTo(0.25);
    h.tick(0, 12);
    expect(h.progress).toBeCloseTo(0.75);
    h.tick(0, 16);
    expect(h.progress).toBeCloseTo(0);
  });

  test("resize keeps the newest slots and a clock that went backwards restarts the hop", () => {
    const h = createHistory(160, 16);
    for (let t = 0; t < 200; t += 16) h.tick(t / 200, t);
    const newest = h.bars[h.bars.length - 1];
    h.resize(80, 16);
    expect(h.bars.length).toBe(5);
    expect(h.bars[4]).toBeCloseTo(newest);
    h.tick(0.5, 10); // earlier than before — a new context
    expect(h.progress).toBe(0);
    h.reset();
    expect([...h.bars]).toEqual([0, 0, 0, 0, 0]);
  });
});
