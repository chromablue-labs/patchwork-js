import { AudioError } from "./errors";
import { Emitter } from "./events";
import { Mic } from "./lifecycle/mic";
import { resolveOptions } from "./options";
import { Levels } from "./display/levels";
import { Vad } from "./sensing/vad";
import { Player } from "./transport/player";
import type { EngineEvents, EngineOptions, EngineState, ResolvedOptions } from "./types";

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Outside a user gesture, Chrome leaves `AudioContext.resume()` pending until a
 * gesture eventually arrives — possibly forever. We wait this long, then read
 * `ctx.state` and decide from that.
 */
const UNLOCK_WAIT_MS = 250;

/**
 * One AudioContext and the lifecycle around it. Everything else — the mic,
 * transport, sensing and display — hangs off this.
 */
export class Engine {
  readonly options: ResolvedOptions;
  readonly mic: Mic;
  readonly vad: Vad;
  readonly player: Player;
  readonly levels: Levels;

  private readonly bus = new Emitter<EngineEvents>();
  private ctx: AudioContext | null = null;
  private closed = false;
  /** Set only when the browser itself reports "running". Distinguishes "never woke" from "was interrupted". */
  private everRan = false;
  private lastEmitted: EngineState | null = null;

  constructor(options?: EngineOptions) {
    this.options = resolveOptions(options);
    this.mic = new Mic(this);
    this.vad = new Vad(this);
    this.player = new Player(this);
    this.levels = new Levels(this);
    // Barge-in is composed, not wired into the meter: the VAD reads the mic-only
    // tap, so only a human can trip this — never the assistant's own playback.
    this.vad.on("speech-start", (event) => {
      if (!this.options.bargeIn || this.player.state !== "playing") return;
      this.player.stop();
      this.bus.emit("barge-in", event);
    });
  }

  /** Computed from the AudioContext on every read. There is no cached flag to go stale. */
  get state(): EngineState {
    if (this.closed) return "closed";
    const ctx = this.ctx;
    if (!ctx) return "locked";
    switch (ctx.state as string) {
      case "running":
        return "ready";
      case "closed":
        return "closed";
      case "interrupted": // Safari reports OS interruptions with their own state
        return "interrupted";
      default: // "suspended"
        return this.everRan ? "interrupted" : "locked";
    }
  }

  /** @internal Whether a context exists yet — lets Display read without creating one. */
  get hasContext(): boolean {
    return this.ctx !== null;
  }

  /**
   * The underlying AudioContext — an escape hatch for the lab and for tests.
   * Created on first access; throws `engine_closed` after `close()`.
   */
  get context(): AudioContext {
    this.assertOpen();
    if (!this.ctx) {
      const Ctor = audioContextCtor();
      if (!Ctor) throw this.fail(new AudioError("unsupported", "Web Audio is not available in this environment"));
      const ctx = new Ctor();
      this.ctx = ctx;
      ctx.addEventListener("statechange", () => {
        if (ctx.state === "running") this.everRan = true;
        this.emitState();
      });
      if (ctx.state === "running") this.everRan = true;
    }
    return this.ctx;
  }

  on<K extends keyof EngineEvents>(event: K, fn: (payload: EngineEvents[K]) => void): () => void {
    return this.bus.on(event, fn);
  }

  /**
   * Wake the context. Call it from a click handler, before any `await` — the
   * gesture that permits it expires. Idempotent; safe to call from every button.
   */
  async unlock(): Promise<void> {
    const ctx = this.context;
    if ((ctx.state as string) !== "running") {
      const resumed = ctx.resume().then(() => true, () => false);
      const waited = new Promise<false>((resolve) => setTimeout(() => resolve(false), UNLOCK_WAIT_MS));
      await Promise.race([resumed, waited]);
    }
    if ((ctx.state as string) !== "running") {
      throw this.fail(
        new AudioError("not_unlocked", "Audio is locked until the user interacts with the page. Call unlock() inside a click handler, before any await."),
      );
    }
    this.everRan = true;
    this.emitState();
  }

  /** Terminal. Every later use throws `engine_closed`; nothing can resurrect a context. */
  close(): void {
    if (this.closed) return;
    this.levels.dispose();
    this.player.dispose();
    this.mic.close();
    this.vad.clear();
    const ctx = this.ctx;
    this.closed = true;
    this.ctx = null;
    if (ctx) void ctx.close().catch(() => undefined);
    this.emitState();
    this.bus.clear();
  }

  /** @internal Record an error on the bus and hand it back to be thrown. Both channels, always. */
  fail(error: AudioError): AudioError {
    this.bus.emit("error", error);
    return error;
  }

  /** @internal */
  emit<K extends keyof EngineEvents>(event: K, payload: EngineEvents[K]): void {
    this.bus.emit(event, payload);
  }

  /** @internal Emit `state` if it changed since the last emit. */
  emitState(): void {
    const state = this.state;
    if (state === this.lastEmitted) return;
    this.lastEmitted = state;
    this.bus.emit("state", state);
  }

  /** @internal */
  assertOpen(): void {
    if (this.closed) throw this.fail(new AudioError("engine_closed", "This engine has been closed; create a new one"));
  }
}

export function createEngine(options?: EngineOptions): Engine {
  return new Engine(options);
}
