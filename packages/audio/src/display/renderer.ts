import type { Levels } from "./levels";
import type { LevelsFrame } from "../types";

/**
 * What every renderer shares: subscribe to frames, watch the box's size in a
 * ResizeObserver (never per frame), honour prefers-reduced-motion, and stop
 * cleanly. Subclasses implement `draw` and `resize`.
 */
export abstract class Renderer {
  protected levels: Levels | null = null;
  protected width = 0;
  protected height = 0;
  protected reducedMotion = false;

  private offFrame: (() => void) | null = null;
  private offActive: (() => void) | null = null;
  private observer: ResizeObserver | null = null;
  private motion: MediaQueryList | null = null;
  private readonly onMotion = (e: MediaQueryListEvent) => {
    this.reducedMotion = e.matches;
  };
  private idleRaf = 0;

  protected constructor(protected readonly element: Element) {}

  /** Start drawing `levels`. Returns `this` so it chains. */
  connect(levels: Levels): this {
    this.disconnect();
    this.levels = levels;
    this.measure();
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(() => this.measure());
      this.observer.observe(this.element);
    }
    if (typeof matchMedia === "function") {
      this.motion = matchMedia("(prefers-reduced-motion: reduce)");
      this.reducedMotion = this.motion.matches;
      this.motion.addEventListener("change", this.onMotion);
    }
    this.offFrame = levels.on("frame", (frame) => this.draw(frame));
    this.offActive = levels.on("active", (active) => (active ? this.stopIdle() : this.startIdle()));
    this.draw(levels.read());
    if (!levels.active) this.startIdle();
    return this;
  }

  disconnect(): void {
    this.offFrame?.();
    this.offActive?.();
    this.offFrame = this.offActive = null;
    this.observer?.disconnect();
    this.observer = null;
    this.motion?.removeEventListener("change", this.onMotion);
    this.motion = null;
    this.stopIdle();
    this.levels = null;
  }

  /** Whether this renderer animates while nothing is feeding the levels (the orb's breath). */
  protected get animatesWhenIdle(): boolean {
    return false;
  }

  protected abstract draw(frame: LevelsFrame): void;
  protected abstract resize(width: number, height: number): void;

  private measure(): void {
    const rect = this.element.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.resize(this.width, this.height);
    if (this.levels) this.draw(this.levels.read());
  }

  /** The idle animation (a breath) needs no more than this. */
  private static readonly IDLE_HZ = 30;

  private startIdle(): void {
    if (this.idleRaf || !this.animatesWhenIdle || this.reducedMotion || typeof requestAnimationFrame !== "function") return;
    let last = -Infinity;
    const step = (now: number) => {
      if (!this.levels) return;
      this.idleRaf = requestAnimationFrame(step);
      if (now - last < 1000 / Renderer.IDLE_HZ - 1) return;
      last = now;
      this.draw(this.levels.read());
    };
    this.idleRaf = requestAnimationFrame(step);
  }

  private stopIdle(): void {
    if (!this.idleRaf) return;
    cancelAnimationFrame(this.idleRaf);
    this.idleRaf = 0;
  }
}

/** The colour to paint with. `currentColor` is resolved once per connect/resize, never per frame. */
export function resolveColor(element: Element, color: string | undefined): string {
  if (color && color !== "currentColor") return color;
  if (typeof getComputedStyle !== "function") return "#000";
  return getComputedStyle(element).color || "#000";
}
