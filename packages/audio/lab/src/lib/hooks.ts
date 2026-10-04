import { useEffect, useRef, useState } from "react";
import type { LevelsFrame } from "@usepatchwork/audio";
import { useEngine } from "./engine";

/** The latest levels frame at `hz`, through the public rate limit. */
export function useFrame(hz = 15): LevelsFrame | null {
  const engine = useEngine();
  const [frame, setFrame] = useState<LevelsFrame | null>(null);
  useEffect(() => engine.levels.on("frame", setFrame, { hz }), [engine, hz]);
  return frame;
}

/** A ring of the last `n` values, appended by the caller. */
export function useRing<T>(n: number) {
  const ref = useRef<T[]>([]);
  const [, bump] = useState(0);
  return {
    values: ref.current,
    push(v: T) {
      ref.current.push(v);
      if (ref.current.length > n) ref.current.splice(0, ref.current.length - n);
      bump((x) => x + 1);
    },
    clear() {
      ref.current = [];
      bump((x) => x + 1);
    },
  };
}

export function fmtMs(ms: number | null | undefined, digits = 0): string {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? "—" : ms.toFixed(digits);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
