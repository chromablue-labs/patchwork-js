import { AudioError } from "./errors";
import type { EngineOptions, LevelsOptions, ResolvedOptions, VadOptions } from "./types";

export const DEFAULT_OPTIONS: ResolvedOptions = {
  bargeIn: true,
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  vad: { enabled: true, sensitivity: 0.5, minSpeechMs: 80, pauseMs: 300, turnEndMs: 900 },
  levels: { historyMs: 700, hopMs: 16, attackMs: 40, releaseMs: 120, fftSize: 2048 },
  take: { maxDurationMs: 120_000, mimeType: undefined, closeAfterTake: false },
  stream: { format: "pcm16k", timesliceMs: 240 },
};

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Deep-merge `patch` over `base`. A key whose value is `undefined` is treated
 * as absent — `createEngine({ levels: { fftSize: props.fftSize } })` with an
 * undefined prop must get the default, not `undefined`. (0.1.0 used a spread
 * and threw from a getter.)
 */
function merge<T>(base: T, patch: unknown): T {
  if (!isPlain(patch)) return base;
  const out: Plain = { ...(base as Plain) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlain(current) && isPlain(value) ? merge(current, value) : value;
  }
  return out as T;
}

function deepFreeze<T>(value: T): T {
  if (isPlain(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AudioError("invalid_option", message);
}

const isMs = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Resolve, validate and freeze. Throws `invalid_option` synchronously — never from a getter later. */
export function resolveOptions(input: EngineOptions | undefined = {}): ResolvedOptions {
  check(isPlain(input), "options must be a plain object");
  const o = merge(structuredClone(DEFAULT_OPTIONS), input);

  check(typeof o.bargeIn === "boolean", `bargeIn must be a boolean (got ${String(o.bargeIn)})`);
  check(isPlain(o.audio), "audio must be a MediaTrackConstraints object");

  validateLevelsOptions(o.levels);

  const durations: [string, unknown][] = [
    ["take.maxDurationMs", o.take.maxDurationMs],
    ["stream.timesliceMs", o.stream.timesliceMs],
  ];
  for (const [path, value] of durations) check(isMs(value), `${path} must be a non-negative number of milliseconds (got ${String(value)})`);
  check(o.stream.timesliceMs > 0, "stream.timesliceMs must be greater than 0");

  check(typeof o.vad.enabled === "boolean", "vad.enabled must be a boolean");
  validateVadOptions(o.vad);
  check(o.stream.format === "pcm16k" || o.stream.format === "opus", `stream.format must be "pcm16k" or "opus" (got ${String(o.stream.format)})`);
  check(o.take.mimeType === undefined || typeof o.take.mimeType === "string", "take.mimeType must be a string");
  check(typeof o.take.closeAfterTake === "boolean", "take.closeAfterTake must be a boolean");

  return deepFreeze(o);
}

/** The VAD's tunables, validated the same way whether they arrive at `createEngine` or `vad.options = …`. */
export function validateVadOptions(o: VadOptions): VadOptions {
  const { sensitivity, minSpeechMs, pauseMs, turnEndMs } = o;
  check(typeof sensitivity === "number" && sensitivity >= 0 && sensitivity <= 1, `vad.sensitivity must be between 0 and 1 (got ${String(sensitivity)})`);
  for (const [path, value] of [["vad.minSpeechMs", minSpeechMs], ["vad.pauseMs", pauseMs], ["vad.turnEndMs", turnEndMs]] as const) {
    check(isMs(value), `${path} must be a non-negative number of milliseconds (got ${String(value)})`);
  }
  check(turnEndMs >= pauseMs, `vad.turnEndMs (${turnEndMs}) must be at least vad.pauseMs (${pauseMs}) — the turn cannot end before the pause does`);
  return { sensitivity, minSpeechMs, pauseMs, turnEndMs };
}

/** Levels' tunables, validated the same way whether they arrive at `createEngine` or `levels.options = …`. */
export function validateLevelsOptions(o: LevelsOptions): LevelsOptions {
  const { historyMs, hopMs, attackMs, releaseMs, fftSize } = o;
  check(
    Number.isInteger(fftSize) && fftSize >= 32 && fftSize <= 32768 && (fftSize & (fftSize - 1)) === 0,
    `levels.fftSize must be a power of two between 32 and 32768 (got ${String(fftSize)})`,
  );
  for (const [path, value] of [["levels.historyMs", historyMs], ["levels.hopMs", hopMs], ["levels.attackMs", attackMs], ["levels.releaseMs", releaseMs]] as const) {
    check(isMs(value), `${path} must be a non-negative number of milliseconds (got ${String(value)})`);
  }
  check(hopMs > 0, "levels.hopMs must be greater than 0");
  check(historyMs >= hopMs, `levels.historyMs (${historyMs}) must be at least levels.hopMs (${hopMs}) — the strip needs one slot`);
  return { historyMs, hopMs, attackMs, releaseMs, fftSize };
}
