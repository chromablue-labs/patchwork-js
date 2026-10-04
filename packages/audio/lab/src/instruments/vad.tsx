import { Button, NumberInput, Slider, Tag } from "@parrot-co/parrot-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { VadEvent, VadEventName } from "@usepatchwork/audio";
import { Card, Empty, Readout, ReadoutRow, SectionHeader } from "@/components/card";
import { useEngine, useLab, usePolled } from "@/lib/engine";
import { fmtMs } from "@/lib/hooks";
import { useSource } from "@/lib/source-context";

type Sample = { t: number; level: number; threshold: number; floor: number; speaking: number };
type Marker = { name: VadEventName; at: number; t: number };

const WINDOW_MS = 8000;
const SAMPLE_HZ = 25;
const MARK_COLOR: Record<VadEventName, string> = { "speech-start": "#0ea5e9", "speech-end": "#a3a3a3", "turn-end": "#ec4899" };

/** Level vs noise floor vs threshold on a scrolling chart; VAD events as markers; the four options live. */
export function VadTuner() {
  const engine = useEngine();
  const { options, setOptions } = useLab();
  const source = useSource();
  const [samples, setSamples] = useState<Sample[]>([]);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [turns, setTurns] = useState<{ at: number; t: number; turnEndMs: number }[]>([]);
  const [opts, setOpts] = useState(() => ({ ...engine.vad.options }));
  const [error, setError] = useState<string | null>(null);
  const clock = useRef(0);

  useEffect(() => setOpts({ ...engine.vad.options }), [engine]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!engine.hasContext) return;
      let t = 0;
      try {
        t = engine.context.currentTime * 1000;
      } catch {
        return;
      }
      clock.current = t;
      const v = engine.vad;
      setSamples((prev) => {
        const next = prev.length > WINDOW_MS / (1000 / SAMPLE_HZ) + 10 ? prev.slice(-Math.round(WINDOW_MS / (1000 / SAMPLE_HZ))) : prev.slice();
        next.push({ t, level: v.level ?? 0, threshold: v.threshold ?? 0, floor: v.noiseFloor ?? -100, speaking: v.speaking ? 1 : 0 });
        return next;
      });
      setMarkers((prev) => prev.filter((m) => m.at > t - WINDOW_MS));
    }, 1000 / SAMPLE_HZ);
    return () => clearInterval(id);
  }, [engine]);

  useEffect(() => {
    const on = (name: VadEventName) => (e: VadEvent) => {
      setMarkers((prev) => [...prev, { name, at: e.at, t: e.t }]);
      if (name === "turn-end") setTurns((prev) => [{ at: e.at, t: e.t, turnEndMs: engine.vad.options.turnEndMs }, ...prev].slice(0, 6));
    };
    const offs = [engine.vad.on("speech-start", on("speech-start")), engine.vad.on("speech-end", on("speech-end")), engine.vad.on("turn-end", on("turn-end"))];
    return () => offs.forEach((off) => off());
  }, [engine]);

  const live = usePolled(
    useCallback(() => ({ level: engine.vad.level, threshold: engine.vad.threshold, floor: engine.vad.noiseFloor, speaking: engine.vad.speaking, enabled: engine.vad.enabled }), [engine]),
    10,
  );

  function apply(patch: Partial<typeof opts>) {
    const next = { ...opts, ...patch };
    setOpts(next);
    try {
      engine.vad.options = patch;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const t0 = samples.length ? samples[samples.length - 1].t - WINDOW_MS : 0;
  const data = samples.map((s) => ({ ...s, x: (s.t - t0) / 1000 }));
  const floorUnit = (db: number) => Math.max(0, Math.min(1, (db + 65) / 40)); // the stage's own 40 dB window over ABS_MIN

  return (
    <>
      <Card>
        <SectionHeader
          title="Level · threshold · noise floor"
          description="Everything the stage sees, on the audio clock. Markers sit at `at` — the onset — not at the moment the detector was sure."
          action={
            <div className="flex items-center gap-2">
              {(["speech-start", "speech-end", "turn-end"] as const).map((n) => (
                <span key={n} className="flex items-center gap-1.5 text-2xs text-text-light">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: MARK_COLOR[n] }} />
                  {n}
                </span>
              ))}
            </div>
          }
        />
        {!live.enabled ? (
          <Empty>vad.enabled is false for this engine — switch it on in Lifecycle → construction options.</Empty>
        ) : !source.running && source.kind !== "microphone" ? (
          <Empty>Start a signal above.</Empty>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-border-subtle)" vertical={false} />
              <XAxis dataKey="x" type="number" domain={[0, WINDOW_MS / 1000]} tick={{ fontSize: 10, fill: "var(--color-text-light)" }} tickFormatter={(v: number) => `${(v - WINDOW_MS / 1000).toFixed(0)}s`} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 10, fill: "var(--color-text-light)" }} />
              <Line type="monotone" dataKey="level" stroke="var(--color-text-dark)" dot={false} isAnimationActive={false} strokeWidth={1.5} />
              <Line type="stepAfter" dataKey="threshold" stroke="#f59e0b" dot={false} isAnimationActive={false} strokeDasharray="4 3" />
              <Line type="monotone" dataKey={(s: Sample) => floorUnit(s.floor)} stroke="#a3a3a3" dot={false} isAnimationActive={false} name="floor" />
              <Line type="stepAfter" dataKey={(s: Sample) => s.speaking * 0.06} stroke="#0ea5e9" dot={false} isAnimationActive={false} strokeWidth={3} name="speaking" />
              {markers.map((m, i) => (
                <ReferenceLine key={i} x={(m.at - t0) / 1000} stroke={MARK_COLOR[m.name]} strokeWidth={m.name === "turn-end" ? 2 : 1} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
        <ReadoutRow className="mt-3">
          <Readout label="level" value={live.level === null ? "—" : live.level.toFixed(2)} />
          <Readout label="threshold" value={live.threshold === null ? "—" : live.threshold.toFixed(2)} />
          <Readout label="noise floor" value={live.floor === null ? "—" : live.floor.toFixed(1)} unit="dBFS" />
          <Readout label="speaking" value={live.speaking === null ? "null" : String(live.speaking)} />
        </ReadoutRow>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionHeader title="Options — live" description="vad.options = { … } updates the running worklet; validated the same way as createEngine." />
          <div className="flex flex-col gap-4">
            <div>
              <div className="flex justify-between text-[13px] mb-1">
                <span>sensitivity</span>
                <span className="readout">{opts.sensitivity.toFixed(2)} → margin {(20 - 16 * opts.sensitivity).toFixed(1)} dB above the floor</span>
              </div>
              <Slider size="sm" aria-label="sensitivity" minValue={0} maxValue={1} step={0.05} value={opts.sensitivity} onChange={(v) => apply({ sensitivity: Array.isArray(v) ? v[0] : v })} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <NumberInput size="sm" appearance="outline" label="minSpeechMs" value={opts.minSpeechMs} minValue={0} step={20} onChange={(v) => Number.isFinite(v) && apply({ minSpeechMs: v })} />
              <NumberInput size="sm" appearance="outline" label="pauseMs" value={opts.pauseMs} minValue={0} step={50} onChange={(v) => Number.isFinite(v) && apply({ pauseMs: v })} />
              <NumberInput size="sm" appearance="outline" label="turnEndMs" value={opts.turnEndMs} minValue={0} step={100} onChange={(v) => Number.isFinite(v) && apply({ turnEndMs: v })} />
            </div>
            {error && <div className="text-2xs text-red-600">{error}</div>}
            <p className="text-2xs text-text-light leading-relaxed">
              Two silences: <span className="font-mono">pauseMs</span> bridges the gaps inside a sentence; <span className="font-mono">turnEndMs</span> says the user is done. The second cannot be shorter than the first.
            </p>
            <div className="divider" />
            <div className="flex items-center justify-between">
              <span className="text-[13px]">vad.enabled (construction)</span>
              <Button size="xs" radius="sm" variant="outline" color="neutral" onPress={() => setOptions({ vad: { ...options.vad, enabled: !(options.vad?.enabled ?? true) } })}>
                {(options.vad?.enabled ?? true) ? "disable + rebuild" : "enable + rebuild"}
              </Button>
            </div>
          </div>
        </Card>
        <Card>
          <SectionHeader title="End-of-turn latency" description="turn-end carries `at` (when the silence began) and `t` (when the detector was sure). t − at should equal turnEndMs." />
          {turns.length === 0 ? (
            <Empty>No turn has ended yet. Synthetic voice ends one every few seconds.</Empty>
          ) : (
            <div className="flex flex-col gap-1.5">
              {turns.map((u, i) => {
                const latency = u.t - u.at;
                const delta = latency - u.turnEndMs;
                return (
                  <div key={i} className="flex items-center gap-3 text-[13px]">
                    <span className="readout w-24">at {(u.at / 1000).toFixed(2)}s</span>
                    <span className="readout w-28">sure +{fmtMs(latency)} ms</span>
                    <Tag size="sm" variant="pastel" radius="sm" color={Math.abs(delta) <= 60 ? "lime" : "amber"} className="font-mono text-[11px] px-1.5">
                      {delta >= 0 ? "+" : ""}
                      {fmtMs(delta)} ms vs turnEndMs {u.turnEndMs}
                    </Tag>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
