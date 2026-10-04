import { Button, NumberInput, Select, Slider, Tag, Textarea } from "@parrot-co/parrot-ui";
import { IconPlayerPlay, IconPlayerSkipForward, IconPlayerStop, IconPlaylistAdd } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MseSink, type PlayResult, type Sink, type SinkFormat } from "@usepatchwork/audio";
import { ApiConfigCard } from "@/components/api-config";
import { Card, Empty, Readout, ReadoutRow, SectionHeader } from "@/components/card";
import { listVoices, readApiConfig, speak, speakStream, type Voice } from "@/lib/api";
import { pump } from "@/lib/chunker";
import { useEngine, useEngineEvent, useLab, usePolled } from "@/lib/engine";
import { fmtBytes, fmtMs } from "@/lib/hooks";
import { useSource } from "@/lib/source-context";
import { syntheticReply, toneSamples, wavBlob } from "@/lib/sources";

type Item = { id: number; label: string; via: "play" | "enqueue"; startMs: number | null; result: PlayResult | "pending" | "error"; wallMs: number | null };

let nextItem = 1;
/** The sink emits "start" too; those must not be attributed to a queued clip. */
let sinkActive = false;

export function PlayerInstrument() {
  const engine = useEngine();
  const { note, options } = useLab();
  const source = useSource();
  const playerState = useEngineEvent("player");
  const [items, setItems] = useState<Item[]>([]);
  const [volume, setVolume] = useState(100);
  const pendingStart = useRef<{ id: number; at: number }[]>([]);
  const [, setApiTick] = useState(0);
  const api = readApiConfig();

  // Latency: play()/enqueue() call → the "start" event, in wall time.
  useEffect(
    () =>
      engine.player.on("start", () => {
        if (sinkActive) return;
        const head = pendingStart.current.shift();
        if (!head) return;
        const ms = performance.now() - head.at;
        setItems((prev) => prev.map((i) => (i.id === head.id ? { ...i, startMs: ms } : i)));
      }),
    [engine],
  );

  const submit = useCallback(
    (label: string, src: Blob, via: "play" | "enqueue") => {
      const id = nextItem++;
      const at = performance.now();
      setItems((prev) => [{ id, label, via, startMs: null, result: "pending" as const, wallMs: null }, ...prev].slice(0, 12));
      pendingStart.current.push({ id, at });
      const p = via === "play" ? engine.player.play(src) : engine.player.enqueue(src);
      if (via === "play") pendingStart.current = pendingStart.current.filter((x) => x.id === id); // play() drops the queue
      p.then(
        (result) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, result, wallMs: performance.now() - at } : i))),
        () => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, result: "error", wallMs: performance.now() - at } : i))),
      );
    },
    [engine],
  );

  const reply = () => syntheticReply(24000, 3);
  const beep = (hz: number) => wavBlob(toneSamples(700, hz, 24000), 24000);

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <Card>
          <SectionHeader
            title="Clips"
            description="play() is now — it interrupts and drops the queue. enqueue() is after — sentence-by-sentence TTS. Both resolve { completed, playedMs }."
            action={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" radius="sm" variant="solid" color="neutral" prepend={<IconPlayerPlay size={14} />} onPress={() => submit("synthetic reply", reply(), "play")}>
                  play(reply)
                </Button>
                <Button size="sm" radius="sm" variant="outline" color="neutral" prepend={<IconPlaylistAdd size={14} />} onPress={() => [330, 440, 550].forEach((hz) => submit(`tone ${hz}`, beep(hz), "enqueue"))}>
                  enqueue ×3
                </Button>
                <Button size="sm" radius="sm" variant="outline" color="neutral" prepend={<IconPlayerSkipForward size={14} />} onPress={() => engine.player.skip()} isDisabled={playerState !== "playing"}>
                  skip()
                </Button>
                <Button size="sm" radius="sm" variant="outline" color="neutral" prepend={<IconPlayerStop size={14} />} onPress={() => engine.player.stop()} isDisabled={playerState !== "playing"}>
                  stop()
                </Button>
              </div>
            }
          />
          {(options.bargeIn ?? true) && source.running && (
            <p className="mb-3 text-2xs text-text-light">
              bargeIn is on and a signal is running: when it speaks, playback is cut and the queue dropped — that is the barge-in in the Lifecycle timeline.
            </p>
          )}
          {items.length === 0 ? (
            <Empty>Nothing played yet.</Empty>
          ) : (
            <div className="flex flex-col gap-1">
              {items.map((i) => (
                <div key={i.id} className="flex items-center gap-3 text-[13px] py-1 border-b border-border-subtle last:border-0">
                  <Tag size="sm" variant="outline" radius="sm" color="neutral" className="font-mono text-[11px] px-1.5 w-20 justify-center">
                    {i.via}()
                  </Tag>
                  <span className="text-text-dark w-32 truncate">{i.label}</span>
                  <span className="readout w-28">start {fmtMs(i.startMs)} ms</span>
                  {i.result === "pending" ? (
                    <span className="readout">…</span>
                  ) : i.result === "error" ? (
                    <span className="text-red-600 text-2xs">error</span>
                  ) : (
                    <>
                      <Tag size="sm" variant="pastel" radius="sm" color={i.result.completed ? "lime" : "amber"} className="font-mono text-[11px] uppercase px-1.5">
                        completed: {String(i.result.completed)}
                      </Tag>
                      <span className="readout">played {fmtMs(i.result.playedMs)} ms</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <SectionHeader title="Volume" description="Ramped over 20 ms — never a click." />
          <Slider
            size="sm"
            aria-label="volume"
            minValue={0}
            maxValue={100}
            value={volume}
            onChange={(v) => {
              const n = Array.isArray(v) ? v[0] : v;
              setVolume(n);
              engine.player.volume = n / 100;
            }}
          />
          <div className="readout mt-2">player.volume = {(volume / 100).toFixed(2)}</div>
        </Card>
      </div>

      <SpeakCard api={api} onPlay={(label, blob) => submit(label, blob, "play")} note={note} />
      <SinkCard api={api} />
      <ApiConfigCard onChange={() => setApiTick((t) => t + 1)} />
    </>
  );
}

function SpeakCard({ api, onPlay, note }: { api: ReturnType<typeof readApiConfig>; onPlay: (label: string, blob: Blob) => void; note: (t: string) => void }) {
  const [text, setText] = useState("Hello from the audio lab. This is the real voice, through the real player.");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ ms: number; bytes: number; type: string } | string | null>(null);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    listVoices(api).then(
      (v) => alive && setVoices(v),
      (err) => alive && setLast(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      alive = false;
    };
  }, [api?.url, api?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  async function go() {
    if (!api) return;
    setBusy(true);
    try {
      const { blob, ms } = await speak(api, text, voiceId ?? undefined);
      setLast({ ms, bytes: blob.size, type: blob.type });
      note(`speak: ${fmtBytes(blob.size)} ${blob.type} in ${ms.toFixed(0)} ms`);
      onPlay("speak", blob);
    } catch (err) {
      setLast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Speak"
        description={api ? "text → POST /v1/voice/speak → player.play(blob). Today the API buffers the whole MP3; ENG-61 streams it." : "Off until the platform API is configured below."}
        action={
          <Button size="sm" radius="sm" variant="solid" color="neutral" isLoading={busy} isDisabled={!api || !text.trim()} onPress={() => void go()}>
            speak
          </Button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-[1fr_220px]">
        <Textarea size="sm" appearance="outline" aria-label="text" rows={2} value={text} onChange={setText} isDisabled={!api} />
        <Select
          size="sm"
          radius="sm"
          aria-label="voice"
          placeholder={voices.length ? "Default voice" : "No voices loaded"}
          items={voices}
          labelKey="name"
          valueKey="id"
          value={voiceId}
          isDisabled={!api || voices.length === 0}
          onChange={(k) => setVoiceId(k ? String(k) : null)}
        />
      </div>
      {last && (
        <div className="mt-3 readout">
          {typeof last === "string" ? <span className="text-red-600">{last}</span> : `whole clip in ${last.ms.toFixed(0)} ms · ${fmtBytes(last.bytes)} · ${last.type}`}
        </div>
      )}
    </Card>
  );
}

function SinkCard({ api }: { api: ReturnType<typeof readApiConfig> }) {
  const engine = useEngine();
  const { note } = useLab();
  const [format, setFormat] = useState<SinkFormat>("pcm");
  const [intervalMs, setIntervalMs] = useState(20);
  const [chunkBytes, setChunkBytes] = useState(960);
  const [sink, setSink] = useState<Sink | null>(null);
  const [result, setResult] = useState<PlayResult | null>(null);
  const [network, setNetwork] = useState<{ firstByteMs: number; totalMs: number; bytes: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const stats = usePolled(useCallback(() => (sink ? { ...sink.stats, state: sink.state } : null), [sink]), 8);
  const mseOk = typeof MediaSource !== "undefined" && MseSink.supported("mp3");

  async function feedSynthetic() {
    sinkActive = true;
    const s = engine.player.stream({ format: "pcm", sampleRate: 24000 });
    void s.done.finally(() => (sinkActive = false));
    setSink(s);
    setResult(null);
    setNetwork(null);
    abort.current = new AbortController();
    const blob = syntheticReply(24000, 4);
    const bytes = new Uint8Array(await blob.arrayBuffer()).subarray(44); // strip the WAV header → raw Int16 LE
    const { chunks } = await pump(bytes, (c) => s.write(c), { intervalMs, chunkBytes, jitter: 0.4 }, abort.current.signal);
    const r = await s.end();
    setResult(r);
    note(`pcm sink: ${chunks} chunks, first audio ${fmtMs(s.stats.firstAudioMs)} ms, underruns ${s.stats.underruns}, completed ${r.completed}`);
  }

  async function feedSpeak() {
    if (!api) return;
    sinkActive = true;
    const s = engine.player.stream({ format: "mp3" });
    void s.done.finally(() => (sinkActive = false));
    setSink(s);
    setResult(null);
    setNetwork(null);
    try {
      const n = await speakStream(api, "Streaming this reply as the bytes arrive.", undefined, (chunk) => s.write(chunk));
      setNetwork(n);
      const r = await s.end();
      setResult(r);
      note(`mp3 sink via speak: first byte ${n.firstByteMs.toFixed(0)} ms, first audio ${fmtMs(s.stats.firstAudioMs)} ms`);
    } catch (err) {
      s.abort();
      note(`speak stream failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Streaming sink"
        description="player.stream({ format }) accepts bytes as they arrive. pcm is scheduled gaplessly on the audio clock; mp3 goes through MediaSource. First-audio latency is measured from stream()."
        action={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" radius="sm" variant="solid" color="neutral" isDisabled={sink !== null && sink.state !== "done"} onPress={() => void feedSynthetic()}>
              feed pcm from the chunker
            </Button>
            <Button size="sm" radius="sm" variant="outline" color="neutral" isDisabled={!api || !mseOk || (sink !== null && sink.state !== "done")} onPress={() => void feedSpeak()}>
              stream speak as mp3
            </Button>
            <Button size="sm" radius="sm" variant="outline" color="neutral" isDisabled={!sink || sink.state === "done"} onPress={() => { abort.current?.abort(); sink?.abort(); }}>
              abort()
            </Button>
          </div>
        }
      />
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <Select size="sm" radius="sm" label="format" aria-label="format" items={[{ id: "pcm", label: "pcm (24 kHz)" }, { id: "mp3", label: `mp3 via MSE${mseOk ? "" : " — unsupported here"}` }]} labelKey="label" valueKey="id" value={format} onChange={(k) => k && setFormat(String(k) as SinkFormat)} className="w-56" />
        <NumberInput size="sm" appearance="outline" label="chunk interval (ms)" value={intervalMs} minValue={0} step={5} onChange={(v) => Number.isFinite(v) && setIntervalMs(v)} className="w-40" />
        <NumberInput size="sm" appearance="outline" label="chunk bytes ± 40%" value={chunkBytes} minValue={2} step={100} onChange={(v) => Number.isFinite(v) && setChunkBytes(v)} className="w-40" />
        <span className="text-2xs text-text-light pb-2">960 B every 20 ms is exactly real-time at 24 kHz; smaller or slower chunks force underruns.</span>
      </div>
      <ReadoutRow>
        <Readout label="state" value={stats?.state ?? "—"} />
        <Readout label="chunks" value={stats?.chunks ?? "—"} />
        <Readout label="bytes" value={stats ? fmtBytes(stats.bytes) : "—"} />
        <Readout label="underruns" value={stats?.underruns ?? "—"} />
        <Readout label="first audio after stream()" value={fmtMs(stats?.firstAudioMs)} unit="ms" />
        <Readout label="network first byte" value={fmtMs(network?.firstByteMs)} unit="ms" />
        <Readout label="completed" value={result ? String(result.completed) : "—"} />
        <Readout label="playedMs" value={fmtMs(result?.playedMs)} unit="ms" />
      </ReadoutRow>
    </Card>
  );
}
