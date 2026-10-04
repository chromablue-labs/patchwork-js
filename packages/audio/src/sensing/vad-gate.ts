import type { VadEventName, VadTiming } from "../types";

/**
 * Turns a per-frame loud/quiet verdict into speech-start / speech-end /
 * turn-end, on the audio clock, with two silences:
 *
 *   minSpeechMs  — loud this long before we believe it (kills clicks)
 *   pauseMs      — quiet this long ends the utterance   (bridges gaps inside a sentence)
 *   turnEndMs    — quiet this long ends the turn        (the user is done; send it)
 *
 * `at` on every event is when the thing actually happened — the onset of
 * loudness for speech-start, the start of the silence for the other two —
 * not the moment we became sure of it.
 *
 * Plain function, ES2020 only — stringified into the AudioWorklet.
 */
export function createVadGate(initial: VadTiming): {
  readonly speaking: boolean;
  setOptions(patch: Partial<VadTiming>): void;
  update(loud: boolean, t: number): { event: VadEventName; at: number }[];
  reset(): void;
} {
  let opts = { minSpeechMs: initial.minSpeechMs, pauseMs: initial.pauseMs, turnEndMs: initial.turnEndMs };
  let speaking = false;
  let loudSince = -1;
  let quietSince = -1;
  let turnOpen = false;

  return {
    get speaking() {
      return speaking;
    },
    setOptions(patch) {
      opts = {
        minSpeechMs: patch.minSpeechMs ?? opts.minSpeechMs,
        pauseMs: patch.pauseMs ?? opts.pauseMs,
        turnEndMs: patch.turnEndMs ?? opts.turnEndMs,
      };
    },
    update(loud, t) {
      const events: { event: VadEventName; at: number }[] = [];
      if (!speaking) {
        if (loud) {
          if (loudSince < 0) loudSince = t;
          if (t - loudSince >= opts.minSpeechMs) {
            speaking = true;
            turnOpen = true;
            quietSince = -1;
            events.push({ event: "speech-start", at: loudSince });
            loudSince = -1;
          }
        } else {
          loudSince = -1;
          if (turnOpen && quietSince >= 0 && t - quietSince >= opts.turnEndMs) {
            turnOpen = false;
            events.push({ event: "turn-end", at: quietSince });
          }
        }
      } else if (!loud) {
        if (quietSince < 0) quietSince = t;
        if (t - quietSince >= opts.pauseMs) {
          speaking = false;
          loudSince = -1;
          events.push({ event: "speech-end", at: quietSince });
          // quietSince is kept: turn-end measures from the same silence
        }
      } else {
        quietSince = -1;
      }
      return events;
    },
    reset() {
      speaking = false;
      loudSince = -1;
      quietSince = -1;
      turnOpen = false;
    },
  };
}
