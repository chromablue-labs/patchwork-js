/**
 * The bar strip — time-based. `historyMs / hopMs` slots; a new one every
 * `hopMs` on the audio clock, holding the loudest level seen during that hop.
 * Because the clock, not the caller, decides when a slot turns over, a 30 Hz
 * tab and a 120 Hz display show the same 0.7 s (principle 1). Pure: tested
 * at 30/60/120 Hz call rates for identical output.
 */
export type History = {
  /** Oldest first, 0..1. Replaced (not mutated) on every resize; mutated in place on tick. */
  readonly bars: Float32Array;
  readonly hopMs: number;
  /** 0..1 through the current hop. */
  readonly progress: number;
  /** Feed the current level at audio-clock `nowMs`. */
  tick(level: number, nowMs: number): void;
  resize(historyMs: number, hopMs: number): void;
  /** Forget everything; the next tick starts a fresh hop. */
  reset(): void;
};

/** Slots for a strip. `700 / 16` → 44. */
export function slotCount(historyMs: number, hopMs: number): number {
  return Math.max(1, Math.round(historyMs / hopMs));
}

export function createHistory(historyMs: number, hopMs: number): History {
  let bars = new Float32Array(slotCount(historyMs, hopMs));
  let hop = hopMs;
  let hopStart: number | null = null;
  let pending = 0; // the loudest level so far in the current hop
  let progress = 0;

  function commit(value: number, steps: number): void {
    const n = bars.length;
    if (steps >= n) {
      bars.fill(value);
      return;
    }
    bars.copyWithin(0, steps);
    bars.fill(value, n - steps);
  }

  return {
    get bars() {
      return bars;
    },
    get hopMs() {
      return hop;
    },
    get progress() {
      return progress;
    },
    tick(level, nowMs) {
      if (hopStart === null || nowMs < hopStart) {
        hopStart = nowMs;
        pending = level;
        progress = 0;
        return;
      }
      const steps = Math.floor((nowMs - hopStart) / hop);
      if (steps > 0) {
        // The hop that just ended gets the loudest level seen during it; hops
        // nobody observed (a throttled tab) get the level found on waking,
        // which also opens the current hop.
        commit(pending, 1);
        if (steps > 1) commit(level, steps - 1);
        hopStart += steps * hop;
        pending = level;
      } else {
        pending = Math.max(pending, level);
      }
      progress = (nowMs - hopStart) / hop;
    },
    resize(nextHistoryMs, nextHopMs) {
      const next = new Float32Array(slotCount(nextHistoryMs, nextHopMs));
      // Keep the newest slots so a live strip does not blank on an options change.
      const keep = Math.min(next.length, bars.length);
      next.set(bars.subarray(bars.length - keep), next.length - keep);
      bars = next;
      hop = nextHopMs;
      hopStart = null;
      progress = 0;
    },
    reset() {
      bars.fill(0);
      hopStart = null;
      pending = 0;
      progress = 0;
    },
  };
}
