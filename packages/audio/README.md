# @usepatchwork/audio

A browser audio engine for voice UX. Framework-agnostic, one `AudioContext`, one microphone stream, and a worklet on the audio thread. It answers the questions a voice interface asks — *can I use the mic, is the user talking, are they done, give me what they said, play this and tell me how it ended, did they interrupt, what should I draw* — and answers nothing else.

No backend, no speech-to-text, no text-to-speech: those are the platform's seams. This is what the SDK's mic button stands on.

The design is in [`docs/specs/audio.md`](../../docs/specs/audio.md). This README is the short version.

```sh
bun add @usepatchwork/audio
```

## Quick start

```ts
import { createEngine } from "@usepatchwork/audio";

const audio = createEngine();

button.onclick = async () => {
  await audio.unlock();          // inside the gesture, before any await
  await audio.mic.open();        // "requesting" while the prompt is up
  const take = audio.mic.record();
  await new Promise((r) => setTimeout(r, 3000));
  const clip = await take.stop(); // { blob, mimeType, durationMs, cancelled }
  const reply = await fetch("/v1/voice/speak", { method: "POST", body: JSON.stringify({ text: "…" }) });
  const { completed } = await audio.player.play(await reply.blob());
  if (!completed) console.log("the user interrupted");
};

audio.on("error", (e) => console.warn(e.code, e.recoverable, e.message));
```

Four concerns, four objects on the engine:

| | Asks | Object |
|---|---|---|
| Lifecycle | can I make sound, can I use the mic, what went wrong | `audio`, `audio.mic` |
| Transport | give me what they said; play this | `audio.mic.record()` / `.stream()`, `audio.player` |
| Sensing | is a human talking, did they just stop | `audio.vad` |
| Display | what should I draw this frame | `audio.levels`, `@usepatchwork/audio/visualizers` |

Five principles hold everywhere: timing is on the audio clock, never the screen's; the VAD reads a mic-only tap that playback cannot reach; a Take and a Stream are different objects; the lifecycle is a state machine with events; visualisers are geometry plus thin renderers.

## Lifecycle

```ts
audio.state            // "locked" | "ready" | "interrupted" | "closed" — derived from the AudioContext, never cached
await audio.unlock()   // call from a click handler; throws not_unlocked outside a gesture
audio.close()          // terminal
audio.on("state" | "mic" | "player" | "devices" | "error" | "barge-in" | "take-limit", fn)
```

```ts
audio.mic.state        // "unavailable" | "idle" | "requesting" | "ready" | "recording" | "streaming" | "denied" | "lost"
audio.mic.isPresent    audio.mic.isReady    audio.mic.isListening
await audio.mic.open({ device? })      // idempotent; constraints deep-merge over the engine's `audio` defaults
await audio.mic.open({ stream })       // a MediaStream you already hold stands in for the microphone
audio.mic.close()                      // stops the tracks; "idle"
await audio.mic.devices()              // MediaDeviceInfo[]; "devices" fires on devicechange
audio.mic.settings()                   // what the browser actually granted
```

`denied` and `lost` are states, so a UI can render "microphone blocked" and "microphone disconnected" without catching anything. They are also emitted as errors. After a Take the mic stays warm by default so the next one starts instantly; `close()` is explicit, or set `take.closeAfterTake`.

## Transport in

**Take — push to talk.** The handle comes back synchronously, so a release during the permission prompt is never lost.

```ts
const take = audio.mic.record();   // throws take_in_progress / stream_in_progress instead of no-op
const clip = await take.stop();    // { blob, mimeType, durationMs, cancelled } — durationMs on the audio clock
take.cancel();                     // stop() resolves an empty clip flagged cancelled
```

The blob is a container file (`audio/webm;codecs=opus`, `audio/mp4` on Safari) — what `POST /v1/voice/transcribe` takes. `maxDurationMs` (default 120 000) auto-stops and emits `take-limit`.

**Stream — live.**

```ts
const live = audio.mic.stream({ format: "pcm16k" });   // the default; or "opus"
for await (const frame of live) send(frame.data);       // { data, t, speaking }
await live.stop();                                      // resolves after the final frame
```

`pcm16k` gives 20 ms Int16 frames (320 samples) produced in the worklet — anti-aliased and resampled from the context rate. Every frame stands alone, which is what streaming speech-to-text wants. `opus` gives MediaRecorder chunks at the timeslice, and they are **cumulative**: only chunk 0 carries the header, so send 0..n together, never chunk n alone. `speaking` is the VAD's verdict at that frame, or `null` when the VAD is off.

## Transport out

```ts
await audio.player.play(src)        // now: interrupts the current item and drops the queue → { completed, playedMs }
audio.player.enqueue(src)           // after: sentence-by-sentence TTS without clips cutting each other off
audio.player.stop()   audio.player.skip()   audio.player.volume = 0.8   // ramped, never a click
audio.player.on("start" | "end" | "interrupted" | "queue-empty", fn)
```

`src` is a `Blob`, `ArrayBuffer` or view in any container the browser decodes. `completed: false` is the interruption answer — a voice loop that awaits playback before listening can tell the difference.

**Streaming sink** — playback that starts on the first chunk:

```ts
const sink = audio.player.stream({ format: "pcm", sampleRate: 24000 });   // or "mp3" / "opus" via MediaSource
for await (const chunk of response.body) sink.write(chunk);
const { completed } = await sink.end();   // resolves when the last sample has played, or on interruption
sink.stats                                // { chunks, bytes, underruns, firstAudioMs }
```

PCM chunks are scheduled gaplessly on the audio clock, with first audio about 20 ms after the first byte. `MseSink.supported(format)` says up front whether a container format can stream here. The platform endpoint streams `pcm_24000` once ENG-61 lands; until then `play(blob)` is the path.

**Barge-in** is composed, not wired: a `speech-start` while the player is playing stops the player and emits `barge-in` on the engine. The VAD reads the mic-only tap, so the assistant cannot interrupt itself. Off with `bargeIn: false`.

## Sensing

```ts
audio.vad.speaking     audio.vad.level     audio.vad.threshold     audio.vad.noiseFloor
audio.vad.on("speech-start" | "speech-end" | "turn-end", (e) => e.at /* audio-clock ms, when it happened */)
audio.vad.options = { sensitivity: 0.5, minSpeechMs: 80, pauseMs: 300, turnEndMs: 900 };   // applies live
```

An adaptive noise floor (falls fast, rises slowly) with `sensitivity` as a margin above it, so one setting works in a café and a studio. Two silences: `pauseMs` bridges the gaps inside a sentence, `turnEndMs` declares the turn over, once. Every event carries `at` (the onset, retroactive) and `t` (when the detector was sure). It runs in the worklet on every 20 ms frame whenever the mic is open, unaffected by frame rate or tab visibility. `vad: { enabled: false }` runs no stage; consumers who endpoint server-side simply don't subscribe.

## Display

```ts
audio.levels.on("frame", (f) => …, { hz: 20 })   // { t, rms, peak, level, speaking, bars, hopMs, hopProgress, mic, player }
audio.levels.read()                              // pull, for your own rAF loop
audio.levels.pcm()                               // { timeDomain, frequency } — copied on demand
audio.levels.options = { historyMs: 700, hopMs: 16, attackMs: 40, releaseMs: 120, fftSize: 2048 };
```

A frame is about 400 bytes with no PCM inside. `level` is dB over a 50 dB window mapped to 0..1 and smoothed on elapsed time, so it reads the same at 30 Hz and 120 Hz. `bars` are `historyMs / hopMs` slots that turn over on the audio clock — every display shows the same 0.7 s. `mic` and `player` come from their own taps, so a visualiser can colour by who is talking. The loop runs only while something feeds the mix and someone is subscribed.

```ts
import { Bars, Orb, barGeometry, orbGeometry } from "@usepatchwork/audio/visualizers";

new Bars.Canvas(canvas, { glide: true }).connect(audio.levels);
new Bars.Svg(svg, { enterFrom: "right" }).connect(audio.levels);
new Orb.Canvas(canvas, { idleBreath: true }).connect(audio.levels);
```

Three looks — bars, gliding bars, orb — each in canvas and SVG. The geometry functions are exported on their own: `barGeometry(frame, w, h, opts)` returns `Bar[]`, `orbGeometry(frame, w, h, opts)` returns `{ cx, cy, r, glow, hue, breath, who }`, and a React component, WebGL, or anything else can draw from them. SVG renderers keep their nodes and mutate attributes in place. Every renderer honours `prefers-reduced-motion`.

## Errors

One surface: `AudioError` with a typed `code` and `recoverable`, always thrown **and** emitted on `audio.on("error")`.

`unsupported` · `not_unlocked` · `permission_denied` · `no_microphone` · `device_lost` · `engine_closed` · `take_in_progress` · `stream_in_progress` · `decode_failed` · `invalid_option`

## Options

```ts
createEngine({
  bargeIn: true,
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  vad: { enabled: true, sensitivity: 0.5, minSpeechMs: 80, pauseMs: 300, turnEndMs: 900 },
  levels: { historyMs: 700, hopMs: 16, attackMs: 40, releaseMs: 120, fftSize: 2048 },
  take: { maxDurationMs: 120_000, mimeType: undefined, closeAfterTake: false },
  stream: { format: "pcm16k", timesliceMs: 240 },
});
```

`undefined` means absent — `{ vad: { sensitivity: props.s } }` with `props.s === undefined` gets the default. Everything is validated up front; failures throw `invalid_option` from `createEngine`. Every duration is `…Ms`.

## The lab

`packages/audio/lab/` is the package's own instrument panel: a standalone Vite + React app in the platform's visual system that imports the package by source alias, so every change in `src/` is live.

```sh
bun run lab            # http://localhost:5800
```

Nothing in it needs a microphone or a backend. The Signal bar picks what plays the user — microphone, synthetic voice, a file, a tone — and feeds it through `mic.open({ stream })`. Eight instruments: lifecycle console, take recorder, stream inspector, player (clips, the streaming sink with a synthetic chunker, and Speak), VAD tuner, visualiser gallery, turn simulator, and a scenario runner that replays the teardown's attacks against a live engine. Speak and transcribe switch on once `VITE_PATCHWORK_URL` and a token are supplied.

## Development

```sh
bun install
bun run typecheck
bun test                               # unit — dsp, geometry, history, options, the VAD core at 30/60/120 Hz
bun run build                          # ESM + CJS + DTS, both entry points
bun run test:browser                   # Playwright: real Chromium, a fake capture device, the REAL autoplay policy
bun run lab:check                      # typecheck + build the lab (CI runs this too)
```

The browser suite is the adversarial review of 0.1.0 turned into named tests: release-before-open, stop-delivers-the-final-frame, chunk-rate-equals-timeslice, playback-never-trips-the-VAD, barge-in-fires, device-loss-emits, undefined-options-take-defaults, close-is-terminal, and the format decodability checks. It never runs with `--autoplay-policy=no-user-gesture-required` for anything touching suspension — that flag disables the behaviour under test.

Layout:

```
src/
  engine.ts            createEngine, state, unlock/close, the event bus
  lifecycle/mic.ts     the Mic state machine
  transport/           take.ts, stream.ts, player.ts, sink.ts, decode.ts, mime.ts
  sensing/             worklet.ts (capture → resample → VAD stage), energy-vad.ts, vad-gate.ts, vad.ts
  display/             levels.ts, history.ts, geometry.ts, renderer.ts, canvas.ts, svg.ts
  dsp.ts errors.ts options.ts types.ts
  index.ts             main entry
  visualizers.ts       secondary entry
lab/                   the lab
test/unit              bun test
test/browser           playwright
```

React glue (`useAudio`, a `<Bars/>` component) lives in `@usepatchwork/react` and consumes this package.

## License

MIT
