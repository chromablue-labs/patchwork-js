import { describe, expect, test } from "bun:test";
import { AudioError } from "../../src/errors";
import { DEFAULT_OPTIONS, resolveOptions } from "../../src/options";

describe("resolveOptions", () => {
  test("no input gives the defaults", () => {
    expect(resolveOptions()).toEqual(DEFAULT_OPTIONS);
    expect(resolveOptions({})).toEqual(DEFAULT_OPTIONS);
  });

  test("an explicitly-undefined key takes the default (the React prop pattern)", () => {
    const o = resolveOptions({
      levels: { fftSize: undefined, hopMs: undefined },
      vad: { sensitivity: undefined },
      audio: { deviceId: undefined },
      bargeIn: undefined,
    });
    expect(o.levels.fftSize).toBe(2048);
    expect(o.levels.hopMs).toBe(16);
    expect(o.vad.sensitivity).toBe(0.5);
    expect(o.audio.echoCancellation).toBe(true);
    expect(o.bargeIn).toBe(true);
  });

  test("audio constraints deep-merge — picking a device keeps echo cancellation", () => {
    const o = resolveOptions({ audio: { deviceId: "headset-abc" } });
    expect(o.audio).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: "headset-abc",
    });
  });

  test("explicit false overrides a default", () => {
    const o = resolveOptions({ bargeIn: false, audio: { echoCancellation: false }, vad: { enabled: false } });
    expect(o.bargeIn).toBe(false);
    expect(o.audio.echoCancellation).toBe(false);
    expect(o.vad.enabled).toBe(false);
  });

  test("the result is frozen and the defaults are untouched", () => {
    const o = resolveOptions({ vad: { sensitivity: 0.9 } });
    expect(() => {
      (o.vad as { sensitivity: number }).sensitivity = 0.1;
    }).toThrow();
    expect(DEFAULT_OPTIONS.vad.sensitivity).toBe(0.5);
  });

  const bad: [string, Parameters<typeof resolveOptions>[0]][] = [
    ["fftSize not a power of two", { levels: { fftSize: 1000 } }],
    ["fftSize too small", { levels: { fftSize: 16 } }],
    ["negative duration", { vad: { pauseMs: -1 } }],
    ["NaN duration", { levels: { attackMs: NaN } }],
    ["zero hop", { levels: { hopMs: 0 } }],
    ["sensitivity above 1", { vad: { sensitivity: 1.5 } }],
    ["unknown stream format", { stream: { format: "wav" as never } }],
    ["non-boolean bargeIn", { bargeIn: "yes" as never }],
  ];
  for (const [name, input] of bad) {
    test(`rejects ${name} with invalid_option`, () => {
      let caught: unknown;
      try {
        resolveOptions(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AudioError);
      expect((caught as AudioError).code).toBe("invalid_option");
      expect((caught as AudioError).recoverable).toBe(false);
    });
  }
});
