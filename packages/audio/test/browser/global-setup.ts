import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SILENCE_FIXTURE, VOICE_FIXTURE } from "../../playwright.config";

/**
 * A 4-second, 48 kHz mono WAV that Chromium plays as the fake microphone, on
 * loop. Voice-like syllables (a harmonic tone, 140 ms on / 60 ms off, ~−22
 * dBFS) over room noise (~−70 dBFS):
 *
 *   0.0–0.6  noise        0.6–1.6  voice (5 syllables)
 *   1.6–3.0  noise        3.0–3.4  voice (2 syllables)
 *   3.4–4.0  noise
 *
 * With the default gate (minSpeech 80, pause 300, turnEnd 900) that is one
 * ~1000 ms utterance and one ~400 ms utterance per loop, each followed by a
 * turn-end 900 ms into the silence.
 */
export const TIMELINE = {
  seconds: 4,
  rate: 48000,
  voice: [
    [0.6, 1.6],
    [3.0, 3.4],
  ] as [number, number][],
  syllableOnMs: 140,
  syllableOffMs: 60,
  voiceDb: -22,
  noiseDb: -70,
};

function generate(voice: [number, number][] = TIMELINE.voice): Buffer {
  const { seconds, rate, syllableOnMs, syllableOffMs, voiceDb, noiseDb } = TIMELINE;
  const n = seconds * rate;
  const samples = new Float32Array(n);
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000 - 0.5;
  };
  const noiseAmp = Math.pow(10, noiseDb / 20) * Math.sqrt(12); // uniform noise RMS = amp/√12
  for (let i = 0; i < n; i++) samples[i] = rand() * noiseAmp;

  const period = (syllableOnMs + syllableOffMs) / 1000;
  const on = syllableOnMs / 1000;
  const f0 = 180;
  for (const [start, end] of voice) {
    for (let i = Math.floor(start * rate); i < Math.floor(end * rate); i++) {
      const t = i / rate;
      const inSyllable = (t - start) % period < on;
      if (!inSyllable) continue;
      const phase = 2 * Math.PI * f0 * t;
      const tone = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase) + 0.12 * Math.sin(4 * phase);
      const wobble = 1 - 0.3 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t));
      const edge = Math.min(1, ((t - start) % period) / 0.01, (on - ((t - start) % period)) / 0.01); // 10 ms ramps
      samples[i] += tone * wobble * edge;
    }
  }
  // scale the voice so its RMS lands at voiceDb
  let sum = 0;
  let count = 0;
  for (const [start, end] of voice) {
    for (let i = Math.floor(start * rate); i < Math.floor(end * rate); i++) {
      sum += samples[i] * samples[i];
      count++;
    }
  }
  const rms = count ? Math.sqrt(sum / count) : 1;
  const gain = Math.pow(10, voiceDb / 20) / rms;
  for (const [start, end] of voice) {
    for (let i = Math.floor(start * rate); i < Math.floor(end * rate); i++) samples[i] *= gain;
  }

  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2);
  }
  return buf;
}

export default function globalSetup(): void {
  mkdirSync(dirname(VOICE_FIXTURE), { recursive: true });
  writeFileSync(VOICE_FIXTURE, generate());
  writeFileSync(SILENCE_FIXTURE, generate([]));
}
