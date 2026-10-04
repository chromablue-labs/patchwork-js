import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createEngine, type AudioError, type Engine, type EngineOptions, type EngineState, type MicState, type PlayerState } from "@usepatchwork/audio";

/**
 * One engine for the whole lab, created from the options the panel holds.
 * Changing an option that only exists at construction (`bargeIn`, `audio`,
 * `take`, `stream`) rebuilds the engine; the VAD and Levels options apply
 * live through their setters. Everything the instruments show arrives
 * through `audio.on(...)` — the lab consumes only the public surface.
 */
export type LogEntry = {
  id: number;
  /** performance.now() ms since the lab loaded. */
  at: number;
  /** Audio-clock ms if the engine had a context, else null. */
  t: number | null;
  kind: "state" | "mic" | "player" | "vad" | "error" | "barge-in" | "take-limit" | "devices" | "lab";
  text: string;
  detail?: unknown;
};

type EngineStore = {
  engine: Engine;
  options: EngineOptions;
  setOptions: (patch: EngineOptions) => void;
  rebuild: () => void;
  log: LogEntry[];
  note: (text: string, detail?: unknown) => void;
  clearLog: () => void;
};

const EngineContext = createContext<EngineStore | null>(null);

const MAX_LOG = 400;

export function EngineProvider({ children }: { children: ReactNode }) {
  const [options, setOptionsState] = useState<EngineOptions>({});
  const [generation, setGeneration] = useState(0);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: LogEntry["kind"], text: string, detail?: unknown, t: number | null = null) => {
    setLog((prev) => {
      const entry: LogEntry = { id: nextId.current++, at: performance.now(), t, kind, text, detail };
      const next = prev.length >= MAX_LOG ? prev.slice(prev.length - MAX_LOG + 1) : prev.slice();
      next.push(entry);
      return next;
    });
  }, []);

  // The engine lives and dies with this effect, so StrictMode's mount →
  // unmount → mount gives a fresh one instead of a closed one.
  useEffect(() => {
    const e = createEngine(options);
    const clock = () => {
      try {
        return e.hasContext ? e.context.currentTime * 1000 : null;
      } catch {
        return null;
      }
    };
    const offs = [
      e.on("state", (s) => push("state", `engine → ${s}`, undefined, clock())),
      e.on("mic", (s) => push("mic", `mic → ${s}`, undefined, clock())),
      e.on("player", (s) => push("player", `player → ${s}`, undefined, clock())),
      e.on("error", (err: AudioError) => push("error", `${err.code}${err.recoverable ? "" : " (fatal)"} — ${err.message}`, err, clock())),
      e.on("barge-in", (ev) => push("barge-in", `barge-in at ${ev.at.toFixed(0)} ms`, ev, clock())),
      e.on("take-limit", () => push("take-limit", "take hit maxDurationMs", undefined, clock())),
      e.on("devices", (d) => push("devices", `${d.length} input device(s)`, d, clock())),
      e.vad.on("speech-start", (ev) => push("vad", `speech-start (at ${ev.at.toFixed(0)}, sure at ${ev.t.toFixed(0)})`, ev, clock())),
      e.vad.on("speech-end", (ev) => push("vad", `speech-end (at ${ev.at.toFixed(0)}, sure at ${ev.t.toFixed(0)})`, ev, clock())),
      e.vad.on("turn-end", (ev) => push("vad", `turn-end (at ${ev.at.toFixed(0)}, sure at ${ev.t.toFixed(0)})`, ev, clock())),
    ];
    push("lab", `engine created${Object.keys(options).length ? " with " + JSON.stringify(options) : ""}`);
    setEngine(e);
    return () => {
      for (const off of offs) off();
      e.close();
    };
  }, [options, generation, push]);

  const store = useMemo<EngineStore | null>(
    () =>
      engine && {
        engine,
        options,
        setOptions: (patch) => setOptionsState((prev) => ({ ...prev, ...patch })),
        rebuild: () => setGeneration((g) => g + 1),
        log,
        note: (text, detail) => push("lab", text, detail),
        clearLog: () => setLog([]),
      },
    [engine, options, log, push],
  );

  if (!store) return null;
  return <EngineContext.Provider value={store}>{children}</EngineContext.Provider>;
}

export function useLab(): EngineStore {
  const store = useContext(EngineContext);
  if (!store) throw new Error("useLab outside EngineProvider");
  return store;
}

export function useEngine(): Engine {
  return useLab().engine;
}

/** Subscribe to one engine event and re-render with its latest payload. */
export function useEngineEvent<K extends "state" | "mic" | "player">(event: K): K extends "state" ? EngineState : K extends "mic" ? MicState : PlayerState {
  const engine = useEngine();
  type Value = K extends "state" ? EngineState : K extends "mic" ? MicState : PlayerState;
  const read = (): Value => {
    if (event === "state") return engine.state as Value;
    if (event === "mic") return engine.mic.state as Value;
    return engine.player.state as Value;
  };
  const subscribe = useCallback((cb: () => void) => engine.on(event, cb), [engine, event]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Read a derived value at a steady rate (for readouts that have no event). */
export function usePolled<T>(read: () => T, hz = 10): T {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const id = setInterval(() => setValue(read()), 1000 / hz);
    return () => clearInterval(id);
  }, [read, hz]);
  return value;
}
