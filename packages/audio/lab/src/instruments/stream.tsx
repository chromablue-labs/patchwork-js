import { Button, NumberInput, Select, Tag } from "@parrot-co/parrot-ui";
import { useRef, useState } from "react";
import type { Stream, StreamFormat, StreamFrame } from "@usepatchwork/audio";
import { Card, Empty, Readout, ReadoutRow, SectionHeader } from "@/components/card";
import { useEngine, useLab, usePolled } from "@/lib/engine";
import { fmtBytes, fmtMs } from "@/lib/hooks";
import { useSource } from "@/lib/source-context";
import { wavBlob } from "@/lib/sources";

type Stats = { frames: number; bytes: number; startedAt: number; stoppedAt: number | null; lastT: number | null; speaking: (boolean | null)[]; sizes: number[]; firstFrameMs: number | null };
type Decodability = { format: StreamFormat; rows: { label: string; ok: boolean; detail: string }[] };

const fresh = (): Stats => ({ frames: 0, bytes: 0, startedAt: performance.now(), stoppedAt: null, lastT: null, speaking: [], sizes: [], firstFrameMs: null });

export function StreamInspector() {
  const engine = useEngine();
  const { note } = useLab();
  const source = useSource();
  const [format, setFormat] = useState<StreamFormat>("pcm16k");
  const [timesliceMs, setTimeslice] = useState(240);
  const [stream, setStream] = useState<Stream<Int16Array> | Stream<Blob> | null>(null);
  const [check, setCheck] = useState<Decodability | null>(null);
  const [checking, setChecking] = useState(false);
  const stats = useRef<Stats>(fresh());
  const kept = useRef<(Int16Array | Blob)[]>([]);
  const view = usePolled(() => ({ ...stats.current, speaking: stats.current.speaking.slice(-120) }), 8);

  function start() {
    stats.current = fresh();
    kept.current = [];
    setCheck(null);
    const s = engine.mic.stream({ format, timesliceMs });
    s.on("data", (frame: StreamFrame) => {
      const st = stats.current;
      st.frames++;
      const size = frame.data instanceof Blob ? frame.data.size : frame.data.byteLength;
      st.bytes += size;
      st.lastT = frame.t;
      st.speaking.push(frame.speaking);
      st.sizes.push(size);
      if (st.firstFrameMs === null) st.firstFrameMs = performance.now() - st.startedAt;
      if (kept.current.length < 400) kept.current.push(frame.data);
    });
    s.on("end", () => setStream(null));
    setStream(s);
    note(`stream started: ${format} @ ${timesliceMs} ms`);
  }

  async function stop() {
    if (!stream) return;
    const s = stream;
    await s.stop();
    stats.current.stoppedAt = performance.now();
    setStream(null);
    note(`stream stopped after ${stats.current.frames} frames`);
  }

  /** Try frames alone and joined, so the documentation ("pcm16k standalone, opus cumulative") stays measured. */
  async function decodability() {
    const frames = kept.current;
    if (frames.length === 0) return;
    setChecking(true);
    const rows: Decodability["rows"] = [];
    const tryDecode = async (blob: Blob) => {
      try {
        const buf = await engine.context.decodeAudioData(await blob.arrayBuffer());
        return { ok: true, detail: `${(buf.duration * 1000).toFixed(0)} ms @ ${buf.sampleRate} Hz` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    };
    if (format === "pcm16k") {
      // the last frame is the partial flush at stop(); the one before it is a full 20 ms
      const picks = [0, Math.floor(frames.length / 2), Math.max(0, frames.length - 2)].filter((i, k, a) => a.indexOf(i) === k);
      for (const i of picks) {
        const f = frames[i] as Int16Array;
        const r = await tryDecode(wavBlob(f, 16000));
        rows.push({ label: `frame ${i} alone (${f.length} samples)`, ok: r.ok, detail: r.detail });
      }
    } else {
      const blobs = frames as Blob[];
      const join = (list: Blob[]) => new Blob(list, { type: blobs[0].type });
      const r0 = await tryDecode(join([blobs[0]]));
      rows.push({ label: "chunk 0 alone", ok: r0.ok, detail: r0.detail });
      if (blobs.length > 1) {
        const r1 = await tryDecode(join([blobs[1]]));
        rows.push({ label: "chunk 1 alone", ok: r1.ok, detail: r1.detail });
        const rAll = await tryDecode(join(blobs.slice(0, Math.min(blobs.length, 8))));
        rows.push({ label: `chunks 0..${Math.min(blobs.length, 8) - 1} joined`, ok: rAll.ok, detail: rAll.detail });
      }
    }
    setCheck({ format, rows });
    setChecking(false);
  }

  const elapsed = ((view.stoppedAt ?? performance.now()) - view.startedAt) / 1000;
  const typical = view.sizes.length ? [...view.sizes].sort((a, b) => a - b)[Math.floor(view.sizes.length / 2)] : null;
  const live = stream !== null;
  const speakingKnown = view.speaking.filter((s) => s !== null).length;

  return (
    <>
      <Card>
        <SectionHeader
          title="Live stream"
          description="pcm16k: 20 ms Int16 frames from the worklet, each decodable alone. opus: MediaRecorder chunks, cumulative."
          action={
            live ? (
              <Button size="sm" radius="sm" variant="solid" color="neutral" onPress={() => void stop()}>
                stop()
              </Button>
            ) : (
              <Button size="sm" radius="sm" variant="solid" color="neutral" onPress={start} isDisabled={!source.running && source.kind !== "microphone"}>
                stream()
              </Button>
            )
          }
        />
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <Select
            size="sm"
            radius="sm"
            label="format"
            aria-label="format"
            items={[{ id: "pcm16k", label: "pcm16k" }, { id: "opus", label: "opus" }]}
            labelKey="label"
            valueKey="id"
            value={format}
            isDisabled={live}
            onChange={(k) => k && setFormat(String(k) as StreamFormat)}
            className="w-40"
          />
          <NumberInput size="sm" appearance="outline" label="timesliceMs (opus)" value={timesliceMs} minValue={20} step={20} isDisabled={live || format !== "opus"} onChange={(v) => Number.isFinite(v) && setTimeslice(v)} className="w-44" />
        </div>
        <ReadoutRow>
          <Readout label="frames" value={view.frames} />
          <Readout label="frames / s" value={elapsed > 0.2 ? (view.frames / elapsed).toFixed(1) : "—"} />
          <Readout label="bytes / s" value={elapsed > 0.2 ? fmtBytes(view.bytes / elapsed) : "—"} />
          <Readout label="first frame after start" value={fmtMs(view.firstFrameMs)} unit="ms" />
          <Readout label="last frame t" value={view.lastT === null ? "—" : (view.lastT / 1000).toFixed(2)} unit="s" />
          <Readout label="typical frame" value={typical === null ? "—" : fmtBytes(typical)} />
          <Readout label="speaking" value={speakingKnown === 0 ? (view.frames ? "null (VAD off)" : "—") : view.speaking[view.speaking.length - 1] ? "true" : "false"} />
          <Readout label="total" value={fmtBytes(view.bytes)} />
        </ReadoutRow>
        <div className="mt-4">
          <div className="text-2xs text-text-light mb-1">per-frame speaking, last 120 frames</div>
          <div className="flex gap-px h-4">
            {view.speaking.map((s, i) => (
              <span key={i} className={`flex-1 rounded-sm ${s === null ? "bg-surface-sunken" : s ? "bg-sky-500" : "bg-neutral-300 dark:bg-neutral-700"}`} />
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="Decodability check"
          description="Which frames decode on their own. This is the check that made 0.1.0's chunk documentation false."
          action={
            <Button size="xs" radius="sm" variant="outline" color="neutral" isLoading={checking} isDisabled={live || kept.current.length === 0} onPress={() => void decodability()}>
              run on the last stream
            </Button>
          }
        />
        {!check ? (
          <Empty>Stop a stream, then run the check.</Empty>
        ) : (
          <div className="flex flex-col gap-1.5">
            {check.rows.map((r) => (
              <div key={r.label} className="flex items-center gap-3 text-[13px]">
                <Tag size="sm" variant="pastel" radius="sm" color={r.ok ? "lime" : "pink"} className="font-mono text-[11px] uppercase px-1.5 w-20 justify-center">
                  {r.ok ? "decodes" : "fails"}
                </Tag>
                <span className="text-text-dark">{r.label}</span>
                <span className="readout truncate">{r.detail}</span>
              </div>
            ))}
            <p className="text-2xs text-text-light mt-2">
              {check.format === "pcm16k" ? "Raw PCM: every frame stands alone — what streaming STT wants." : "A container stream: only chunk 0 carries the header. Ship 0..n together, never chunk n alone."}
            </p>
          </div>
        )}
      </Card>
    </>
  );
}
