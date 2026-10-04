import { levelFromRms } from "../dsp";
import type { Bar, BarGeometryOptions, LevelsFrame, OrbGeometry, OrbGeometryOptions } from "../types";

/**
 * Geometry is the product; renderers are loops. Everything here is a pure
 * function of a frame and a box, so a consumer can draw to React, WebGL or a
 * PDF without reimplementing the maths — and so it is unit-testable.
 */

type BarInput = Pick<LevelsFrame, "bars" | "hopProgress" | "level">;

/**
 * Bars for a `width × height` box. Newest is the last entry.
 *
 * With `glide`, one extra bar carries the live level and slides in from the
 * entry edge over the hop, so the strip flows instead of jumping — the
 * `x = (i + hopProgress) · slot` from the spec.
 */
export function barGeometry(frame: BarInput, width: number, height: number, opts: BarGeometryOptions = {}): Bar[] {
  const total = frame.bars.length;
  const count = Math.max(1, Math.min(total, Math.floor(opts.count ?? total)));
  const gap = opts.gap ?? 2;
  const mirrored = opts.mirrored ?? true;
  const glide = (opts.glide ?? false) && !opts.reducedMotion;
  const enterFrom = opts.enterFrom ?? "left";
  const slot = width / count;
  const w = Math.max(1, slot - gap);
  const minH = Math.min(height, opts.minHeight ?? w);
  const r = opts.radius ?? w / 2;
  const offset = glide ? frame.hopProgress : 0;

  const out: Bar[] = [];
  // k = 0 is the newest committed slot; k = -1 is the live bar entering during a glide.
  for (let k = count - 1; k >= (glide ? -1 : 0); k--) {
    const v = k < 0 ? frame.level : frame.bars[total - 1 - k];
    const along = (k + offset) * slot; // distance from the entry edge to the slot's leading side
    const x = (enterFrom === "left" ? along : width - along - slot) + gap / 2;
    const h = Math.max(minH, v * height);
    const y = mirrored ? (height - h) / 2 : height - h;
    out.push({ x, y, w, h, r: Math.min(r, w / 2, h / 2), v });
  }
  return out;
}

type OrbInput = Pick<LevelsFrame, "t" | "level" | "peak" | "mic" | "player">;

/** Below this the orb is "idle" and breathes. */
const IDLE_LEVEL = 0.03;
const BREATH_AMPLITUDE = 0.04;
const GLOW_MIN = 4;
const GLOW_SPAN = 24;
const MARGIN = 0.9; // room for the glow inside the box

/** One circle. Radius from level, a slow breath when idle, hue by who is talking. */
export function orbGeometry(frame: OrbInput, width: number, height: number, opts: OrbGeometryOptions = {}): OrbGeometry {
  const minR = opts.minRadius ?? 0.55;
  const micHue = opts.micHue ?? 200;
  const playerHue = opts.playerHue ?? 280;
  const period = opts.breathPeriodMs ?? 4000;
  const idleBreath = (opts.idleBreath ?? true) && !opts.reducedMotion;

  const maxR = (Math.min(width, height) / 2) * MARGIN;
  const base = maxR * (minR + (1 - minR) * frame.level);
  const idle = frame.level < IDLE_LEVEL;
  const breath = idle && idleBreath && period > 0 ? maxR * BREATH_AMPLITUDE * Math.sin((2 * Math.PI * frame.t) / period) : 0;

  const m = frame.mic.level;
  const p = frame.player.level;
  const sum = m + p;
  const who: OrbGeometry["who"] = sum < IDLE_LEVEL ? "none" : p > m ? "player" : "mic";
  const weight = sum < IDLE_LEVEL ? 0 : p / sum;

  return {
    cx: width / 2,
    cy: height / 2,
    r: Math.max(0, base + breath),
    glow: GLOW_MIN + GLOW_SPAN * levelFromRms(frame.peak),
    hue: micHue + (playerHue - micHue) * weight,
    breath,
    who,
  };
}
