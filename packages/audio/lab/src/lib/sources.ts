import type { Engine } from "@usepatchwork/audio";

/**
 * Signal sources that stand in for a microphone. Each builds a MediaStream
 * from the engine's own AudioContext (via `createMediaStreamDestination`) and
 * hands it to `mic.open({ stream })`, so sensing, streaming, takes and levels
 * all run exactly as they would on a device. Nothing here touches package
 * internals.
 */
export type SourceKind = "microphone" | "synthetic" | "file" | "tone";

export type SyntheticOptions = {
  /** Loudness of the voice bursts, dBFS RMS. */
  levelDb: number;
  /** Room noise under everything, dBFS RMS. */
  noiseDb: number;
  /** Length of an utterance and of the gap after it. */
  utteranceMs: number;
  gapMs: number;
};

export const SYNTHETIC_DEFAULTS: SyntheticOptions = { levelDb: -22, noiseDb: -65, utteranceMs: 1400, gapMs: 1600 };

export type SourceHandle = {
  kind: SourceKind;
  stream: MediaStream;
  /** Tear the graph down and end the stream's track. The mic will report `lost` unless closed first. */
  stop(): void;
  /** For file sources: the decoded buffer, so a waveform can be drawn. */
  buffer?: AudioBuffer;
};

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Uniform noise at unit RMS, one buffer, looped. */
function noiseBuffer(ctx: AudioContext, seconds = 2): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.SQRT2 * Math.sqrt(1.5); // ≈ unit RMS
  return buffer;
}

/**
 * Speech-shaped noise (band-passed 150–3500 Hz) with a syllable envelope:
 * 140 ms on / 60 ms off inside each utterance, silence between utterances.
 * Deterministic in shape, random in sample values — what the test fixture is.
 */
export function syntheticVoice(engine: Engine, opts: SyntheticOptions = SYNTHETIC_DEFAULTS): SourceHandle {
  const ctx = engine.context;
  const dest = ctx.createMediaStreamDestination();

  const room = ctx.createBufferSource();
  room.buffer = noiseBuffer(ctx);
  room.loop = true;
  const roomGain = ctx.createGain();
  roomGain.gain.value = dbToGain(opts.noiseDb);
  room.connect(roomGain).connect(dest);

  const voice = ctx.createBufferSource();
  voice.buffer = noiseBuffer(ctx, 3);
  voice.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 800;
  band.Q.value = 0.5;
  const syllable = ctx.createGain();
  syllable.gain.value = 0;
  voice.connect(band).connect(syllable).connect(dest);

  const level = dbToGain(opts.levelDb) * 1.8; // the band-pass removes ~half the energy
  const period = (opts.utteranceMs + opts.gapMs) / 1000;
  const t0 = ctx.currentTime + 0.05;
  let cycle = 0;
  let timer = 0;

  // Schedule two cycles ahead on the audio clock, top up on a timer.
  function schedule(): void {
    while (t0 + cycle * period < ctx.currentTime + 2 * period) {
      const start = t0 + cycle * period;
      const end = start + opts.utteranceMs / 1000;
      for (let s = start; s < end; s += 0.2) {
        const on = Math.min(s + 0.14, end);
        syllable.gain.setTargetAtTime(level, s, 0.008);
        syllable.gain.setTargetAtTime(0, on, 0.012);
      }
      cycle++;
    }
    timer = window.setTimeout(schedule, period * 500);
  }

  room.start();
  voice.start();
  schedule();

  return {
    kind: "synthetic",
    stream: dest.stream,
    stop() {
      clearTimeout(timer);
      try { room.stop(); voice.stop(); } catch { /* already stopped */ }
      for (const track of dest.stream.getTracks()) track.stop();
    },
  };
}

export function tone(engine: Engine, hz = 440, db = -18): SourceHandle {
  const ctx = engine.context;
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  osc.frequency.value = hz;
  const gain = ctx.createGain();
  gain.gain.value = dbToGain(db) * Math.SQRT2;
  osc.connect(gain).connect(dest);
  osc.start();
  return {
    kind: "tone",
    stream: dest.stream,
    stop() {
      try { osc.stop(); } catch { /* already stopped */ }
      for (const track of dest.stream.getTracks()) track.stop();
    },
  };
}

export async function fileSource(engine: Engine, file: File | Blob, loop = true): Promise<SourceHandle> {
  const ctx = engine.context;
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const dest = ctx.createMediaStreamDestination();
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.loop = loop;
  node.connect(dest);
  node.start();
  return {
    kind: "file",
    stream: dest.stream,
    buffer,
    stop() {
      try { node.stop(); } catch { /* already stopped */ }
      for (const track of dest.stream.getTracks()) track.stop();
    },
  };
}

/** Peaks of a decoded buffer, for a static waveform. */
export function waveform(buffer: AudioBuffer, columns: number): Float32Array {
  const data = buffer.getChannelData(0);
  const out = new Float32Array(columns);
  const per = Math.max(1, Math.floor(data.length / columns));
  for (let c = 0; c < columns; c++) {
    let max = 0;
    const start = c * per;
    for (let i = start; i < start + per && i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > max) max = v;
    }
    out[c] = max;
  }
  return out;
}

/** A WAV blob from Int16 PCM — for downloads and for feeding the player. */
export function wavBlob(samples: Int16Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.byteLength, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.byteLength, true);
  return new Blob([header, samples.buffer as ArrayBuffer], { type: "audio/wav" });
}

/** An Int16 sine at a given dBFS, with 5 ms edges so it never clicks. */
export function toneSamples(ms: number, hz: number, sampleRate: number, db = -12): Int16Array {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Int16Array(n);
  const amp = dbToGain(db) * Math.SQRT2 * 32767;
  const edge = sampleRate * 0.005;
  for (let i = 0; i < n; i++) {
    const e = Math.min(1, i / edge, (n - 1 - i) / edge);
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * amp * e);
  }
  return out;
}

/** A spoken-sounding synthetic reply for the player: three "words" of shaped noise. Returns a WAV. */
export function syntheticReply(sampleRate = 24000, words = 3, db = -16): Blob {
  const wordMs = 380;
  const gapMs = 140;
  const n = Math.round((sampleRate * (words * (wordMs + gapMs))) / 1000);
  const out = new Int16Array(n);
  const amp = dbToGain(db) * 32767 * 2;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const ms = (i / sampleRate) * 1000;
    const inWord = ms % (wordMs + gapMs) < wordMs;
    const phase = (ms % (wordMs + gapMs)) / wordMs;
    const env = inWord ? Math.sin(Math.PI * phase) : 0;
    lp += ((Math.random() * 2 - 1) - lp) * 0.25; // crude low-pass
    out[i] = Math.max(-32767, Math.min(32767, Math.round(lp * amp * env)));
  }
  return wavBlob(out, sampleRate);
}
