import { Button, NumberInput, Tag } from "@parrot-co/parrot-ui";
import { IconDownload, IconPlayerPlay, IconPlayerRecord, IconPlayerStop, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import type { Clip, Take } from "@usepatchwork/audio";
import { ApiConfigCard } from "@/components/api-config";
import { Card, Empty, Readout, ReadoutRow, SectionHeader } from "@/components/card";
import { Waveform } from "@/components/waveform";
import { readApiConfig, transcribe } from "@/lib/api";
import { useEngine, useEngineEvent, useLab } from "@/lib/engine";
import { fmtBytes, fmtMs, useFrame } from "@/lib/hooks";
import { useSource } from "@/lib/source-context";
import { waveform } from "@/lib/sources";

type Result = Clip & { peaks: Float32Array | null; url: string; wallMs: number; label: string };

export function TakeRecorder() {
  const engine = useEngine();
  const { note, options, setOptions } = useLab();
  const source = useSource();
  const micState = useEngineEvent("mic");
  const frame = useFrame(20);
  const [take, setTake] = useState<Take | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [transcript, setTranscript] = useState<{ text: string; ms: number; confidence?: number } | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setApiTick] = useState(0);
  const startedAt = useRef(0);
  const api = readApiConfig();

  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  async function finish(t: Take, label: string, clipPromise: Promise<Clip>) {
    try {
      const clip = await clipPromise;
      let peaks: Float32Array | null = null;
      if (clip.blob.size > 0 && !clip.cancelled) {
        try {
          const buffer = await engine.context.decodeAudioData(await clip.blob.arrayBuffer());
          peaks = waveform(buffer, 240);
        } catch {
          peaks = null;
        }
      }
      const url = URL.createObjectURL(clip.blob);
      urls.current.push(url);
      setResults((prev) => [{ ...clip, peaks, url, wallMs: performance.now() - startedAt.current, label }, ...prev].slice(0, 6));
      note(`take ${label}: ${clip.cancelled ? "cancelled" : `${clip.durationMs.toFixed(0)} ms, ${fmtBytes(clip.blob.size)}, ${clip.mimeType}`}`);
    } catch (err) {
      note(`take ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (t === take) setTake(null);
    }
  }

  function record() {
    startedAt.current = performance.now();
    const t = engine.mic.record();
    setTake(t);
  }

  function stop() {
    if (!take) return;
    const t = take;
    setTake(null);
    void finish(t, "stop()", t.stop());
  }

  function cancel() {
    if (!take) return;
    const t = take;
    setTake(null);
    t.cancel();
    void finish(t, "cancel()", t.stop());
  }

  /** The 0.1.0 race: the user lets go of the button before the permission prompt resolves. */
  function releaseEarly() {
    engine.mic.close();
    startedAt.current = performance.now();
    const t = engine.mic.record();
    // stop() during "requesting" — the handle exists, the mic does not yet
    void finish(t, "release during open()", t.stop());
  }

  async function sendToTranscribe(r: Result) {
    if (!api) return;
    setBusy(true);
    setTranscript(null);
    try {
      const out = await transcribe(api, r.blob, r.mimeType);
      setTranscript(out);
    } catch (err) {
      setTranscript(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const recording = micState === "recording" || take !== null;
  const level = frame?.mic.level ?? 0;

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <SectionHeader
            title="Push to talk"
            description="record() returns the handle synchronously, so a release during the permission prompt is never lost."
            action={
              <div className="flex gap-2">
                {!recording ? (
                  <Button size="sm" radius="sm" variant="solid" color="neutral" prepend={<IconPlayerRecord size={14} />} onPress={record} isDisabled={!source.running && source.kind !== "microphone"}>
                    record()
                  </Button>
                ) : (
                  <>
                    <Button size="sm" radius="sm" variant="solid" color="neutral" prepend={<IconPlayerStop size={14} />} onPress={stop}>
                      stop()
                    </Button>
                    <Button size="sm" radius="sm" variant="outline" color="neutral" prepend={<IconX size={14} />} onPress={cancel}>
                      cancel()
                    </Button>
                  </>
                )}
                <Button size="sm" radius="sm" variant="outline" color="neutral" onPress={releaseEarly} isDisabled={recording}>
                  release early
                </Button>
              </div>
            }
          />
          <div className="flex items-center gap-3">
            <span className="text-2xs text-text-light w-16">mic level</span>
            <div className="h-2 flex-1 rounded-full bg-surface-sunken overflow-hidden">
              <div className="h-full rounded-full bg-neutral-800 dark:bg-neutral-200 transition-[width] duration-75" style={{ width: `${(level * 100).toFixed(1)}%` }} />
            </div>
            <span className="readout w-12 text-right">{level.toFixed(2)}</span>
          </div>
          {!source.running && source.kind !== "microphone" && (
            <p className="mt-3 text-2xs text-text-light">Start a signal above, or pick Microphone — record() opens the device itself.</p>
          )}
        </Card>
        <Card>
          <SectionHeader title="Take options" description="Rebuilds the engine." />
          <NumberInput
            size="sm"
            appearance="outline"
            label="maxDurationMs"
            value={options.take?.maxDurationMs ?? 120000}
            minValue={500}
            step={500}
            onChange={(v) => Number.isFinite(v) && setOptions({ take: { ...options.take, maxDurationMs: v } })}
            description="take-limit fires on the engine and the take stops itself."
          />
        </Card>
      </div>

      <Card>
        <SectionHeader title="Clips" description="Newest first. durationMs is measured on the audio clock; the waveform is the decoded blob." />
        {results.length === 0 ? (
          <Empty>No takes yet.</Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {results.map((r, i) => (
              <div key={r.url} className="flex flex-col gap-2 rounded border border-border-subtle p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag size="sm" variant="outline" radius="sm" color="neutral" className="font-mono text-[11px] px-1.5">
                    {r.label}
                  </Tag>
                  {r.cancelled && (
                    <Tag size="sm" variant="pastel" radius="sm" color="amber" className="font-mono text-[11px] px-1.5 uppercase">
                      cancelled
                    </Tag>
                  )}
                  <span className="readout">{r.mimeType || "—"}</span>
                  <div className="ml-auto flex gap-2">
                    <Button size="xs" radius="sm" variant="outline" color="neutral" prepend={<IconPlayerPlay size={12} />} isDisabled={r.cancelled || r.blob.size === 0} onPress={() => void engine.player.play(r.blob).catch(() => undefined)}>
                      play
                    </Button>
                    <a href={r.url} download={`take-${i}.${r.mimeType.includes("ogg") ? "ogg" : r.mimeType.includes("mp4") ? "m4a" : "webm"}`}>
                      <Button size="xs" radius="sm" variant="outline" color="neutral" prepend={<IconDownload size={12} />} isDisabled={r.blob.size === 0}>
                        download
                      </Button>
                    </a>
                    <Button size="xs" radius="sm" variant="solid" color="neutral" isLoading={busy} isDisabled={!api || r.cancelled || r.blob.size === 0} onPress={() => void sendToTranscribe(r)}>
                      transcribe
                    </Button>
                  </div>
                </div>
                <Waveform peaks={r.peaks} height={56} />
                <ReadoutRow>
                  <Readout label="durationMs (audio clock)" value={fmtMs(r.durationMs)} unit="ms" />
                  <Readout label="wall time record→clip" value={fmtMs(r.wallMs)} unit="ms" />
                  <Readout label="size" value={fmtBytes(r.blob.size)} />
                  <Readout label="bytes / s" value={r.durationMs > 0 ? fmtBytes((r.blob.size / r.durationMs) * 1000) : "—"} />
                </ReadoutRow>
              </div>
            ))}
          </div>
        )}
        {transcript && (
          <div className="mt-4 rounded bg-surface-sunken px-3 py-2 text-[13px]">
            {typeof transcript === "string" ? (
              <span className="text-red-600">{transcript}</span>
            ) : (
              <>
                <span className="text-text-dark">“{transcript.text}”</span>
                <span className="readout ml-3">
                  {fmtMs(transcript.ms)} ms{transcript.confidence !== undefined ? ` · confidence ${transcript.confidence.toFixed(2)}` : ""}
                </span>
              </>
            )}
          </div>
        )}
      </Card>

      <ApiConfigCard onChange={() => setApiTick((t) => t + 1)} />
    </>
  );
}
