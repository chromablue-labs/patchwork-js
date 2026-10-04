/**
 * `@usepatchwork/audio/visualizers` — the secondary entry point. Opt out by
 * not importing it; the main entry carries no drawing code.
 *
 *   new Bars.Canvas(canvas, { glide: true }).connect(audio.levels);
 *   new Bars.Svg(svg).connect(audio.levels);
 *   new Orb.Canvas(canvas, { idleBreath: true }).connect(audio.levels);
 *   new Orb.Svg(svg).connect(audio.levels);
 *
 * Geometry is exported on its own for anyone drawing elsewhere (React, WebGL).
 */
export { barGeometry, orbGeometry } from "./display/geometry";
export { Renderer } from "./display/renderer";
export { CanvasBars, CanvasOrb, type CanvasBarsOptions, type CanvasOrbOptions } from "./display/canvas";
export { SvgBars, SvgOrb, type SvgBarsOptions, type SvgOrbOptions } from "./display/svg";

import { CanvasBars, CanvasOrb } from "./display/canvas";
import { SvgBars, SvgOrb } from "./display/svg";

export const Bars = { Canvas: CanvasBars, Svg: SvgBars } as const;
export const Orb = { Canvas: CanvasOrb, Svg: SvgOrb } as const;

export type { Bar, BarGeometryOptions, LevelsFrame, LevelsOptions, OrbGeometry, OrbGeometryOptions, SourceLevel } from "./types";
