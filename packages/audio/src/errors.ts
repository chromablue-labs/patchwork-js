import type { AudioErrorCode } from "./types";

const RECOVERABLE: Record<AudioErrorCode, boolean> = {
  unsupported: false,
  not_unlocked: true,
  permission_denied: false,
  no_microphone: false,
  device_lost: true,
  engine_closed: false,
  take_in_progress: true,
  stream_in_progress: true,
  decode_failed: false,
  invalid_option: false,
};

/**
 * The one error type this package produces. `recoverable` tells a UI whether
 * to offer a retry or a different message. Browser exceptions never escape raw.
 */
export class AudioError extends Error {
  readonly code: AudioErrorCode;
  readonly recoverable: boolean;
  readonly cause?: unknown;

  constructor(code: AudioErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "AudioError";
    this.code = code;
    this.recoverable = RECOVERABLE[code];
    if (cause !== undefined) this.cause = cause;
  }
}

/** Map a browser exception (getUserMedia, decodeAudioData, …) onto our codes. */
export function fromBrowserError(value: unknown, fallback: AudioErrorCode): AudioError {
  if (value instanceof AudioError) return value;
  const name =
    typeof value === "object" && value !== null && "name" in value ? String((value as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new AudioError("permission_denied", "Microphone permission was denied", value);
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return new AudioError("no_microphone", "No microphone matched the request", value);
    case "NotReadableError":
    case "AbortError":
      return new AudioError("device_lost", "The microphone could not be read — it may be in use by another app", value);
    case "EncodingError":
      return new AudioError("decode_failed", "The audio could not be decoded", value);
  }
  return new AudioError(fallback, value instanceof Error ? value.message : "Something went wrong with audio", value);
}
