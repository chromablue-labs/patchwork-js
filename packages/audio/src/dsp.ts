/** Root-mean-square of a PCM window — energy across the whole window, not the tallest spike. */
export function rms(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

/** Largest absolute sample in a PCM window. Jumps on clicks and plosives. */
export function peak(samples: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > max) max = magnitude;
  }
  return max;
}

/** Clamp to [0, 1]. NaN and ±Infinity clamp to 0 — one bad sample must not poison the meter for the session. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/**
 * Windowed-sinc (Hamming) low-pass FIR. `cutoff` is a fraction of the sample
 * rate (0 – 0.5). Coefficients are normalised to unity DC gain.
 *
 * Plain function, ES2020 only, no captured module state: its source is
 * stringified into the AudioWorklet (see sensing/worklet.ts).
 */
export function designLowpass(cutoff: number, taps: number): Float32Array {
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * hamming;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

/**
 * Streaming resampler: anti-alias FIR, then linear interpolation on a phase
 * accumulator. Keeps filter history and phase across calls so consecutive
 * blocks join seamlessly. Same-rate input passes straight through.
 *
 * Plain function, ES2020 only — stringified into the AudioWorklet. It must
 * reference nothing but its own arguments and `designLowpass`.
 */
export function createResampler(inRate: number, outRate: number, taps = 31): { push(input: Float32Array): Float32Array } {
  if (inRate === outRate) return { push: (input) => input };
  const ratio = inRate / outRate;
  const h = designLowpass(Math.min(0.45, 0.45 * (outRate / inRate)), taps);
  const hist = new Float32Array(taps - 1);
  let carry = 0;
  let hasCarry = false;
  let phase = 0;
  return {
    push(input: Float32Array): Float32Array {
      const n = input.length;
      const win = new Float32Array(hist.length + n);
      win.set(hist, 0);
      win.set(input, hist.length);
      const filtered = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = 0; k < taps; k++) acc += h[k] * win[i + k];
        filtered[i] = acc;
      }
      hist.set(win.subarray(n));
      let src = filtered;
      if (hasCarry) {
        src = new Float32Array(n + 1);
        src[0] = carry;
        src.set(filtered, 1);
      }
      const out = new Float32Array(Math.ceil((src.length - phase) / ratio) + 1);
      let count = 0;
      let p = phase;
      while (p + 1 < src.length) {
        const i = Math.floor(p);
        const f = p - i;
        out[count++] = src[i] + (src[i + 1] - src[i]) * f;
        p += ratio;
      }
      carry = src[src.length - 1];
      hasCarry = true;
      phase = p - (src.length - 1);
      return out.subarray(0, count);
    },
  };
}

/**
 * One-pole follower with time constants in milliseconds: `next` is chased
 * with `attackMs` when rising and `releaseMs` when falling. Because the
 * coefficient is derived from elapsed time, the result is the same at any
 * call rate — the frame-counted 0.1.0 smoother is what this replaces.
 *
 * Plain function, ES2020 only — stringified into the AudioWorklet.
 */
export function follower(prev: number, next: number, dtMs: number, attackMs: number, releaseMs: number): number {
  const tau = next > prev ? attackMs : releaseMs;
  const k = tau <= 0 ? 1 : 1 - Math.exp(-dtMs / tau);
  return prev + (next - prev) * k;
}

/** dB window a visualiser shows: −50 dBFS is silence (0), full scale is 1. Speech at −20 dBFS sits at 0.6. */
export const LEVEL_RANGE_DB = 50;

/** Linear RMS/peak → 0..1 for drawing. Logarithmic, because ears are. */
export function levelFromRms(value: number, rangeDb: number = LEVEL_RANGE_DB): number {
  if (!(value > 0)) return 0;
  return clamp01((20 * Math.log10(value) + rangeDb) / rangeDb);
}
