import { Button, Switch } from "@parrot-co/parrot-ui";
import { useCallback } from "react";
import { Card, Readout, ReadoutRow, SectionHeader } from "@/components/card";
import { LogTimeline } from "@/components/log-timeline";
import { StateDiagram, type DiagramEdge, type DiagramNode } from "@/components/state-diagram";
import { useEngine, useEngineEvent, useLab, usePolled } from "@/lib/engine";
import { useSource } from "@/lib/source-context";

const ENGINE_NODES: DiagramNode[] = [
  { id: "locked", label: "locked", x: 10, y: 40 },
  { id: "ready", label: "ready", x: 190, y: 40 },
  { id: "interrupted", label: "interrupted", x: 370, y: 40 },
  { id: "closed", label: "closed", x: 190, y: 120 },
];
const ENGINE_EDGES: DiagramEdge[] = [
  { from: "locked", to: "ready", label: "unlock()" },
  { from: "ready", to: "interrupted", label: "OS / tab", bend: -18 },
  { from: "interrupted", to: "ready", label: "resume", bend: -18 },
  { from: "ready", to: "closed", label: "close()" },
];

const MIC_NODES: DiagramNode[] = [
  { id: "idle", label: "idle", x: 10, y: 70 },
  { id: "requesting", label: "requesting", x: 150, y: 70 },
  { id: "ready", label: "ready", x: 290, y: 70 },
  { id: "recording", label: "recording", x: 440, y: 10 },
  { id: "streaming", label: "streaming", x: 440, y: 130 },
  { id: "unavailable", label: "unavailable", x: 10, y: 170 },
  { id: "denied", label: "denied", x: 150, y: 170 },
  { id: "lost", label: "lost", x: 290, y: 170 },
];
const MIC_EDGES: DiagramEdge[] = [
  { from: "idle", to: "requesting", label: "open()" },
  { from: "requesting", to: "ready", label: "granted" },
  { from: "requesting", to: "denied", label: "blocked" },
  { from: "ready", to: "recording", label: "record()" },
  { from: "recording", to: "ready", bend: -30 },
  { from: "ready", to: "streaming", label: "stream()" },
  { from: "streaming", to: "ready", bend: 30 },
  { from: "ready", to: "lost", label: "track ended" },
  { from: "ready", to: "idle", label: "close()", bend: 48 },
];

export function LifecycleConsole() {
  const engine = useEngine();
  const { log, options, setOptions, rebuild, clearLog } = useLab();
  const source = useSource();
  const engineState = useEngineEvent("state");
  const micState = useEngineEvent("mic");

  const contextInfo = usePolled(
    useCallback(() => {
      if (!engine.hasContext) return null;
      try {
        const ctx = engine.context;
        return { state: ctx.state as string, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, currentTime: ctx.currentTime };
      } catch {
        return null;
      }
    }, [engine]),
    5,
  );
  const settings = usePolled(useCallback(() => engine.mic.settings(), [engine]), 2);

  const forceInterrupted = () => {
    if (!engine.hasContext) return;
    void engine.context.suspend();
  };
  const forceLost = () => {
    const stream = engine.mic.mediaStream;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.stop();
      track.dispatchEvent(new Event("ended")); // Chromium does not fire `ended` for a local stop()
    }
  };

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionHeader
            title="Engine"
            description="Derived from the AudioContext on every read — there is no cached flag to go stale."
            action={
              <div className="flex gap-2">
                <Button size="xs" radius="sm" variant="outline" color="neutral" onPress={() => void engine.unlock().catch(() => undefined)}>
                  unlock()
                </Button>
                <Button size="xs" radius="sm" variant="outline" color="neutral" onPress={forceInterrupted} isDisabled={engineState !== "ready"}>
                  force interrupted
                </Button>
                <Button size="xs" radius="sm" variant="outline" color="neutral" onPress={rebuild}>
                  close() + new engine
                </Button>
              </div>
            }
          />
          <StateDiagram nodes={ENGINE_NODES} edges={ENGINE_EDGES} active={engineState} width={500} height={170} />
          <ReadoutRow className="mt-4">
            <Readout label="context.state" value={contextInfo?.state ?? "—"} />
            <Readout label="sampleRate" value={contextInfo ? contextInfo.sampleRate : "—"} unit="Hz" />
            <Readout label="baseLatency" value={contextInfo ? (contextInfo.baseLatency * 1000).toFixed(1) : "—"} unit="ms" />
            <Readout label="currentTime" value={contextInfo ? contextInfo.currentTime.toFixed(2) : "—"} unit="s" />
          </ReadoutRow>
        </Card>

        <Card>
          <SectionHeader
            title="Microphone"
            description="denied and lost are states, so a UI can render them without catching anything."
            action={
              <div className="flex gap-2">
                <Button size="xs" radius="sm" variant="outline" color="neutral" onPress={forceLost} isDisabled={!engine.mic.mediaStream}>
                  force lost
                </Button>
                <Button size="xs" radius="sm" variant="outline" color="neutral" onPress={() => engine.mic.close()} isDisabled={!engine.mic.mediaStream}>
                  close()
                </Button>
              </div>
            }
          />
          <StateDiagram nodes={MIC_NODES} edges={MIC_EDGES} active={micState} width={565} height={210} />
          <ReadoutRow className="mt-4">
            <Readout label="source" value={source.running ? source.kind : "—"} />
            <Readout label="track sampleRate" value={settings?.sampleRate ?? "—"} unit="Hz" />
            <Readout label="channels" value={settings?.channelCount ?? "—"} />
            <Readout
              label="AEC / NS / AGC"
              value={settings ? [settings.echoCancellation, settings.noiseSuppression, settings.autoGainControl].map((v) => (v === undefined ? "?" : v ? "on" : "off")).join(" / ") : "—"}
            />
          </ReadoutRow>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <SectionHeader
            title="Every transition"
            description="Timestamps are the audio clock where the engine had one."
            action={
              <Button size="xs" radius="sm" variant="ghost" color="neutral" onPress={clearLog}>
                clear
              </Button>
            }
          />
          <div className="max-h-[420px] overflow-y-auto pr-1">
            <LogTimeline entries={log} limit={80} />
          </div>
        </Card>
        <Card>
          <SectionHeader title="Construction options" description="These exist only at createEngine; changing one rebuilds the engine." />
          <div className="flex flex-col gap-3">
            <Switch size="sm" isSelected={options.bargeIn ?? true} onChange={(v) => setOptions({ bargeIn: v })}>
              bargeIn
            </Switch>
            <Switch size="sm" isSelected={options.take?.closeAfterTake ?? false} onChange={(v) => setOptions({ take: { ...options.take, closeAfterTake: v } })}>
              take.closeAfterTake
            </Switch>
            <Switch size="sm" isSelected={options.vad?.enabled ?? true} onChange={(v) => setOptions({ vad: { ...options.vad, enabled: v } })}>
              vad.enabled
            </Switch>
            <div className="divider my-1" />
            {(["echoCancellation", "noiseSuppression", "autoGainControl"] as const).map((k) => (
              <Switch
                key={k}
                size="sm"
                isSelected={(options.audio?.[k] as boolean | undefined) ?? true}
                onChange={(v) => setOptions({ audio: { ...options.audio, [k]: v } })}
              >
                audio.{k}
              </Switch>
            ))}
            <p className="text-2xs text-text-light leading-relaxed">Constraints apply to the real microphone only; a supplied stream is taken as is.</p>
          </div>
        </Card>
      </div>
    </>
  );
}
