# Changelog

## 0.2.1

- `exports` now includes `./package.json`. Tooling that reads a dependency's manifest directly could not, because the export map did not list it.

## 0.2.0

First release. A browser audio engine for voice UX: one `AudioContext`, one microphone stream, and a worklet on the audio thread.

Answers what a voice interface asks — microphone permission, whether the user is talking, when they stop, what they said, playback and how it ended, interruption, and what to draw. No speech-to-text or text-to-speech; those are server concerns.
