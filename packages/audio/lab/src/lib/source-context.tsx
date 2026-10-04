import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useEngine, useLab } from "./engine";
import {
  fileSource,
  syntheticVoice,
  tone,
  SYNTHETIC_DEFAULTS,
  type SourceHandle,
  type SourceKind,
  type SyntheticOptions,
} from "./sources";

/**
 * The signal that stands in for "the user". One at a time; it feeds the mic
 * path through `mic.open({ stream })`, or the real device through
 * `mic.open({ device })`. Everything else in the lab just reads the engine.
 */
type SourceStore = {
  kind: SourceKind;
  setKind: (kind: SourceKind) => void;
  device: string | null;
  setDevice: (id: string | null) => void;
  file: File | null;
  setFile: (file: File | null) => void;
  synthetic: SyntheticOptions;
  setSynthetic: (patch: Partial<SyntheticOptions>) => void;
  toneHz: number;
  setToneHz: (hz: number) => void;
  /** The live stand-in, if one is running. */
  handle: SourceHandle | null;
  running: boolean;
  starting: boolean;
  start: () => Promise<void>;
  stop: () => void;
  error: string | null;
};

const SourceContext = createContext<SourceStore | null>(null);

export function SourceProvider({ children }: { children: ReactNode }) {
  const engine = useEngine();
  const { note } = useLab();
  const [kind, setKind] = useState<SourceKind>("microphone");
  const [device, setDevice] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [synthetic, setSyntheticState] =
    useState<SyntheticOptions>(SYNTHETIC_DEFAULTS);
  const [toneHz, setToneHz] = useState(440);
  const [handle, setHandle] = useState<SourceHandle | null>(null);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<SourceHandle | null>(null);

  const stop = useCallback(() => {
    engine.mic.close();
    handleRef.current?.stop();
    handleRef.current = null;
    setHandle(null);
    setRunning(false);
  }, [engine]);

  // A new engine (options rebuild) drops the old source with it.
  useEffect(() => {
    return () => {
      handleRef.current?.stop();
      handleRef.current = null;
      setHandle(null);
      setRunning(false);
    };
  }, [engine]);

  // The mic reports its own closes (device loss, closeAfterTake, an instrument's close button).
  useEffect(
    () =>
      engine.on("mic", (state) => {
        if (
          state === "idle" ||
          state === "lost" ||
          state === "denied" ||
          state === "unavailable"
        ) {
          handleRef.current?.stop();
          handleRef.current = null;
          setHandle(null);
          setRunning(false);
        }
      }),
    [engine],
  );

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      await engine.unlock();
      if (kind === "microphone") {
        await engine.mic.open(device ? { device } : {});
        note(`source: microphone${device ? ` (${device.slice(0, 8)}…)` : ""}`);
      } else {
        // Close a mic that is already open (say, the take recorder's) BEFORE
        // creating the stand-in: the close emits `mic → idle`, which tears
        // down whatever handle is current — and must not be the new one.
        if (engine.mic.mediaStream) engine.mic.close();
        let next: SourceHandle;
        if (kind === "synthetic") next = syntheticVoice(engine, synthetic);
        else if (kind === "tone") next = tone(engine, toneHz);
        else {
          if (!file) throw new Error("Choose an audio file first");
          next = await fileSource(engine, file);
        }
        handleRef.current = next;
        setHandle(next);
        try {
          await engine.mic.open({ stream: next.stream });
        } catch (err) {
          next.stop();
          handleRef.current = null;
          setHandle(null);
          throw err;
        }
        note(`source: ${kind}`);
      }
      setRunning(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, [engine, kind, device, file, synthetic, toneHz, note]);

  const value: SourceStore = {
    kind,
    setKind,
    device,
    setDevice,
    file,
    setFile,
    synthetic,
    setSynthetic: (patch) =>
      setSyntheticState((prev) => ({ ...prev, ...patch })),
    toneHz,
    setToneHz,
    handle,
    running,
    starting,
    start,
    stop,
    error,
  };
  return (
    <SourceContext.Provider value={value}>{children}</SourceContext.Provider>
  );
}

export function useSource(): SourceStore {
  const store = useContext(SourceContext);
  if (!store) throw new Error("useSource outside SourceProvider");
  return store;
}
