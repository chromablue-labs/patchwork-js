import type { BarGeometryOptions, LevelsFrame, OrbGeometryOptions } from "../types";
import { barGeometry, orbGeometry } from "./geometry";
import { Renderer, resolveColor } from "./renderer";

export type CanvasBarsOptions = BarGeometryOptions & {
  /** CSS colour. Default `currentColor`, resolved on connect and resize. */
  color?: string;
};

/** Paints `barGeometry` as rounded rects. One `clearRect` and N fills per frame. */
export class CanvasBars extends Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private color = "#000";
  private dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement, private readonly opts: CanvasBarsOptions = {}) {
    super(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;
  }

  protected resize(width: number, height: number): void {
    this.dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    this.color = resolveColor(this.canvas, this.opts.color);
  }

  protected draw(frame: LevelsFrame): void {
    const { ctx, width, height } = this;
    if (width === 0 || height === 0) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = this.color;
    for (const b of barGeometry(frame, width, height, { ...this.opts, reducedMotion: this.reducedMotion })) {
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(b.x, b.y, b.w, b.h, b.r);
      else ctx.rect(b.x, b.y, b.w, b.h);
      ctx.fill();
    }
  }
}

export type CanvasOrbOptions = OrbGeometryOptions & {
  /** CSS colour; when set, the hue from `orbGeometry` is ignored. */
  color?: string;
  /** Saturation and lightness for the hue-driven fill. Defaults 70 / 55. */
  saturation?: number;
  lightness?: number;
};

/** One circle with a glow. Breathes on its own rAF while nothing is feeding the levels. */
export class CanvasOrb extends Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private color: string | null = null;
  private dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement, private readonly opts: CanvasOrbOptions = {}) {
    super(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;
  }

  protected override get animatesWhenIdle(): boolean {
    return this.opts.idleBreath ?? true;
  }

  protected resize(width: number, height: number): void {
    this.dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    this.color = this.opts.color ? resolveColor(this.canvas, this.opts.color) : null;
  }

  protected draw(frame: LevelsFrame): void {
    const { ctx, width, height } = this;
    if (width === 0 || height === 0) return;
    const o = orbGeometry(frame, width, height, { ...this.opts, reducedMotion: this.reducedMotion });
    const fill = this.color ?? `hsl(${o.hue.toFixed(1)} ${this.opts.saturation ?? 70}% ${this.opts.lightness ?? 55}%)`;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.shadowColor = fill;
    ctx.shadowBlur = o.glow;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(o.cx, o.cy, o.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
