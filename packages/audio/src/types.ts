import type { AudioError } from "./errors";
import type { Take } from "./transport/take";

/** Derived from the AudioContext every time it is read; never cached. */
export type EngineState = "locked" | "ready" | "interrupted" | "closed";

export type MicState =
  | "unavailable" // no capture API, or no device matched
  | "idle"        // API present, nothing asked yet
  | "requesting"  // permission prompt is up
  | "ready"       // permission granted, stream open, nothing capturing
  | "recording"   // a Take is in progress
  | "streaming"   // a Stream is live
  | "denied"      // the user refused
  | "lost";       // the track ended under us — unplugged, revoked, taken

export type AudioErrorCode =
  | "unsupported"
  | "not_unlocked"
  | "permission_denied"
  | "no_microphone"
  | "device_lost"
  | "engine_closed"
  | "take_in_progress"
  | "stream_in_progress"
  | "decode_failed"
  | "invalid_option";

export type StreamFormat = "pcm16k" | "opus";

export type TakeState = "opening" | "recording" | "stopped" | "cancelled";
export type StreamState = "opening" | "live" | "stopped";

/** A finished push-to-talk take. `blob` is a container file — what `POST /v1/voice/transcribe` takes. */
export type Clip = {
  blob: Blob;
  mimeType: string;
  /** Measured on the audio clock, not wall-clock. 0 when cancelled or released before the mic opened. */
  durationMs: number;
  cancelled: boolean;
};

/**
 * One live-mode frame. `pcm16k`: an Int16Array, 16 kHz mono, 20 ms (320
 * samples; the final one may be shorter), complete and decodable on its own.
 * `opus`: a MediaRecorder chunk — cumulative, only decodable in sequence.
 * `t` is audio-clock milliseconds. `speaking` is the VAD's verdict, or null
 * until sensing is enabled (slice 3).
 */
export type StreamFrame<F extends Int16Array | Blob = Int16Array | Blob> = {
  data: F;
  t: number;
  speaking: boolean | null;
};

export type StreamOptions = { format?: StreamFormat; timesliceMs?: number };

export type VadTiming = { minSpeechMs: number; pauseMs: number; turnEndMs: number };
export type VadOptions = VadTiming & { sensitivity: number };
export type VadEventName = "speech-start" | "speech-end" | "turn-end";
/**
 * `at` — audio-clock ms when it happened: the onset of loudness for
 * speech-start, the start of the silence for speech-end and turn-end.
 * `t` — audio-clock ms when the detector became sure of it.
 */
export type VadEvent = { at: number; t: number };
export type VadEvents = { "speech-start": VadEvent; "speech-end": VadEvent; "turn-end": VadEvent };

export type VadReading = { loud: boolean; level: number; threshold: number; noiseFloor: number; levelDb: number };

/**
 * The pluggable half of sensing: per frame, is it loud, and how loud relative
 * to the room. Energy is the v1 stage; a model-based one slots in here.
 */
export interface VadStage {
  setSensitivity(value: number): void;
  process(frame: ArrayLike<number>, t: number, speaking: boolean): VadReading;
}

/** Every duration is milliseconds. Nothing in this package counts frames. */
export type EngineOptions = {
  bargeIn?: boolean;
  audio?: MediaTrackConstraints;
  vad?: { enabled?: boolean; sensitivity?: number; minSpeechMs?: number; pauseMs?: number; turnEndMs?: number };
  levels?: { historyMs?: number; hopMs?: number; attackMs?: number; releaseMs?: number; fftSize?: number };
  take?: { maxDurationMs?: number; mimeType?: string; closeAfterTake?: boolean };
  stream?: { format?: StreamFormat; timesliceMs?: number };
};

export type ResolvedOptions = {
  readonly bargeIn: boolean;
  readonly audio: MediaTrackConstraints;
  readonly vad: { readonly enabled: boolean; readonly sensitivity: number; readonly minSpeechMs: number; readonly pauseMs: number; readonly turnEndMs: number };
  readonly levels: LevelsOptions;
  readonly take: { readonly maxDurationMs: number; readonly mimeType: string | undefined; readonly closeAfterTake: boolean };
  readonly stream: { readonly format: StreamFormat; readonly timesliceMs: number };
};

export type PlayerState = "idle" | "playing";
/** How an item ended. `completed: false` means it was cut — stop(), skip(), play(), or barge-in. */
export type PlayResult = { completed: boolean; playedMs: number };
export type PlaySource = Blob | ArrayBuffer | ArrayBufferView;
export type PlayerEvents = { start: undefined; end: PlayResult; interrupted: PlayResult; "queue-empty": undefined };

export type SinkFormat = "pcm" | "mp3" | "opus";
/** `pcm`: Int16 little-endian mono at `sampleRate` (default 24000). `mp3` / `opus`: a container byte stream via MediaSource. */
export type SinkOptions = { format: SinkFormat; sampleRate?: number };
export type SinkState = "open" | "ending" | "done";
export type SinkStats = { chunks: number; bytes: number; underruns: number; firstAudioMs: number | null };

/** The engine's one bus. Every state change and every error is an event here. */
export type EngineEvents = {
  state: EngineState;
  mic: MicState;
  player: PlayerState;
  devices: MediaDeviceInfo[];
  error: AudioError;
  /** A Take hit `take.maxDurationMs` and was stopped for you. */
  "take-limit": Take;
  /** The user spoke over playback; the player was stopped. Composed from vad speech-start + player playing. */
  "barge-in": VadEvent;
};

// ---------------------------------------------------------------------------
// Display — what should I draw?
// ---------------------------------------------------------------------------

export type LevelsOptions = {
  readonly historyMs: number;
  readonly hopMs: number;
  readonly attackMs: number;
  readonly releaseMs: number;
  readonly fftSize: number;
};

/**
 * One tap's loudness. `rms` and `peak` are the linear measurements (0..1 of
 * full scale); `level` is what to draw — dB over a 50 dB window mapped to
 * 0..1 and chased with the attack/release followers, so it is the same at
 * any frame rate.
 */
export type SourceLevel = { readonly rms: number; readonly peak: number; readonly level: number };

/** ~400 bytes. No PCM — that is behind `levels.pcm()`, copied on demand. */
export type LevelsFrame = SourceLevel & {
  /** Audio-clock ms. */
  readonly t: number;
  readonly speaking: boolean;
  /** `historyMs / hopMs` slots, oldest first, each the loudest `level` seen during that hop. */
  readonly bars: Float32Array;
  readonly hopMs: number;
  /** 0..1 — how far the audio clock is through the current hop. Gliding bars offset by this. */
  readonly hopProgress: number;
  /** The mic-only tap. Zero while the microphone is closed. */
  readonly mic: SourceLevel;
  /** The player tap. Zero while nothing is playing. */
  readonly player: SourceLevel;
};

export type LevelsPcm = { readonly timeDomain: Float32Array; readonly frequency: Float32Array };

export type LevelsEvents = {
  frame: LevelsFrame;
  /** True while something feeds the mix tap (plus a short drain). The frame loop runs only then. */
  active: boolean;
};

/** One bar of the strip. `v` is the level it shows, `x`/`y`/`w`/`h`/`r` are pixels. */
export type Bar = { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly r: number; readonly v: number };

export type BarGeometryOptions = {
  /** Slots to draw — the most recent ones. Defaults to every slot in the frame. */
  count?: number;
  /** Pixels between bars. Default 2. */
  gap?: number;
  /** Pixels; a silent bar is still a dot. Defaults to the bar width. */
  minHeight?: number;
  /** Corner radius in pixels. Defaults to half the bar width (pill). */
  radius?: number;
  /** Grow from the centre line rather than the bottom. Default true. */
  mirrored?: boolean;
  /** Bars travel across the strip instead of snapping between slots. Default false. */
  glide?: boolean;
  /** Which edge the newest bar appears at. Default "left". */
  enterFrom?: "left" | "right";
  /** Forces `glide` off. Renderers pass `prefers-reduced-motion` here. */
  reducedMotion?: boolean;
};

export type OrbGeometry = {
  readonly cx: number;
  readonly cy: number;
  /** Radius in pixels, breath included. */
  readonly r: number;
  /** Glow radius in pixels, from the peak. */
  readonly glow: number;
  /** Degrees, between `micHue` and `playerHue` by who is louder. */
  readonly hue: number;
  /** The breath's contribution to `r`, in pixels; 0 unless idle. */
  readonly breath: number;
  readonly who: "mic" | "player" | "none";
};

export type OrbGeometryOptions = {
  /** Fraction of the largest radius the orb keeps when silent. Default 0.55. */
  minRadius?: number;
  /** Slow radial oscillation when nobody is talking. Default true. */
  idleBreath?: boolean;
  /** Default 4000. */
  breathPeriodMs?: number;
  /** Default 200 (blue). */
  micHue?: number;
  /** Default 280 (violet). */
  playerHue?: number;
  /** Stops the breath. Renderers pass `prefers-reduced-motion` here. */
  reducedMotion?: boolean;
};
