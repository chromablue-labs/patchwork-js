import type { BarGeometryOptions, LevelsFrame, OrbGeometryOptions } from "../types";
import { barGeometry, orbGeometry } from "./geometry";
import { Renderer } from "./renderer";

const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export type SvgBarsOptions = BarGeometryOptions & {
  /** Fill for the bars. Default `currentColor` — style the <svg> and it inherits. */
  color?: string;
};

/**
 * Retained mode, which is what SVG is: N `<rect>`s created once, then only
 * `x`/`y`/`width`/`height` are mutated per frame. Nothing is re-created unless
 * the bar count changes (a glide adds one).
 */
export class SvgBars extends Renderer {
  private readonly group: SVGGElement;
  private rects: SVGRectElement[] = [];

  constructor(readonly svg: SVGSVGElement, private readonly opts: SvgBarsOptions = {}) {
    super(svg);
    this.group = el("g", { fill: opts.color ?? "currentColor" });
    svg.appendChild(this.group);
  }

  /** Removes the drawn nodes too. */
  dispose(): void {
    this.disconnect();
    this.group.remove();
    this.rects = [];
  }

  protected resize(width: number, height: number): void {
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.svg.setAttribute("preserveAspectRatio", "none");
  }

  protected draw(frame: LevelsFrame): void {
    const { width, height } = this;
    if (width === 0 || height === 0) return;
    const bars = barGeometry(frame, width, height, { ...this.opts, reducedMotion: this.reducedMotion });
    while (this.rects.length < bars.length) {
      const r = el("rect");
      this.group.appendChild(r);
      this.rects.push(r);
    }
    while (this.rects.length > bars.length) this.rects.pop()?.remove();
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const r = this.rects[i];
      r.setAttribute("x", b.x.toFixed(2));
      r.setAttribute("y", b.y.toFixed(2));
      r.setAttribute("width", b.w.toFixed(2));
      r.setAttribute("height", b.h.toFixed(2));
      r.setAttribute("rx", b.r.toFixed(2));
    }
  }
}

export type SvgOrbOptions = OrbGeometryOptions & {
  /** Fill; when set, the hue from `orbGeometry` is ignored. */
  color?: string;
  saturation?: number;
  lightness?: number;
};

/** One `<circle>` and a blur filter; `r`, `fill` and the blur's deviation change per frame. */
export class SvgOrb extends Renderer {
  private readonly circle: SVGCircleElement;
  private readonly halo: SVGCircleElement;
  private readonly blur: SVGFEGaussianBlurElement;
  private readonly filterId = `pw-orb-${Math.random().toString(36).slice(2, 8)}`;

  constructor(readonly svg: SVGSVGElement, private readonly opts: SvgOrbOptions = {}) {
    super(svg);
    const defs = el("defs");
    const filter = el("filter", { id: this.filterId, x: "-50%", y: "-50%", width: "200%", height: "200%" });
    this.blur = el("feGaussianBlur", { stdDeviation: "4" });
    filter.appendChild(this.blur);
    defs.appendChild(filter);
    this.halo = el("circle", { filter: `url(#${this.filterId})`, opacity: "0.6" });
    this.circle = el("circle");
    svg.append(defs, this.halo, this.circle);
  }

  dispose(): void {
    this.disconnect();
    this.halo.remove();
    this.circle.remove();
    this.svg.querySelector(`#${this.filterId}`)?.parentElement?.remove();
  }

  protected override get animatesWhenIdle(): boolean {
    return this.opts.idleBreath ?? true;
  }

  protected resize(width: number, height: number): void {
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  protected draw(frame: LevelsFrame): void {
    const { width, height } = this;
    if (width === 0 || height === 0) return;
    const o = orbGeometry(frame, width, height, { ...this.opts, reducedMotion: this.reducedMotion });
    const fill = this.opts.color ?? `hsl(${o.hue.toFixed(1)} ${this.opts.saturation ?? 70}% ${this.opts.lightness ?? 55}%)`;
    for (const c of [this.halo, this.circle]) {
      c.setAttribute("cx", o.cx.toFixed(2));
      c.setAttribute("cy", o.cy.toFixed(2));
      c.setAttribute("fill", fill);
    }
    this.circle.setAttribute("r", o.r.toFixed(2));
    this.halo.setAttribute("r", (o.r + o.glow / 2).toFixed(2));
    this.blur.setAttribute("stdDeviation", (o.glow / 2).toFixed(2));
  }
}
