import { Button, Segment, SegmentGroup, Select } from "@parrot-co/parrot-ui";
import {
  IconMicrophone,
  IconPlayerStop,
  IconWaveSine,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useEngine, useEngineEvent } from "@/lib/engine";
import { useSource } from "@/lib/source-context";
import type { SourceKind } from "@/lib/sources";

const KINDS: { value: SourceKind; label: string }[] = [
  { value: "microphone", label: "Microphone" },
  { value: "synthetic", label: "Synthetic voice" },
  { value: "file", label: "File" },
  { value: "tone", label: "Tone" },
];

/**
 * The signal that plays "the user", chosen once for the whole lab. Nothing
 * here requires a microphone: synthetic voice, a file and a tone all enter the
 * mic path through `mic.open({ stream })`.
 */
export function SourceBar() {
  const engine = useEngine();
  const source = useSource();
  const mic = useEngineEvent("mic");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  // One engine backs the whole lab, so the mic may already be live — opened by
  // an instrument (the take recorder, a stream) rather than by this bar. Drive
  // the control off the engine's own mic state, not just our `running` flag, so
  // it always reflects reality and one click stops whatever is holding the mic.
  const micLive = mic === "ready" || mic === "recording" || mic === "streaming";
  const busy = source.running || micLive;

  useEffect(() => {
    if (source.kind !== "microphone") return;
    let alive = true;
    void engine.mic.devices().then((list) => alive && setDevices(list));
    const off = engine.on("devices", (list) => setDevices(list));
    return () => {
      alive = false;
      off();
    };
  }, [engine, source.kind, mic]);

  const deviceItems = [
    { id: "", label: "Default input" },
    ...devices.map((d, i) => ({
      id: d.deviceId,
      label: d.label || `Input ${i + 1}`,
    })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-border-subtle bg-surface px-4 py-3">
      <span className="text-2xs font-medium uppercase tracking-wide text-text-light">
        Signal
      </span>
      <SegmentGroup
        size="sm"
        radius="full"
        variant="ghost"
        aria-label="Signal source"
        value={source.kind}
        isDisabled={busy}
        onChange={(v) => source.setKind(v as SourceKind)}
      >
        {KINDS.map((k) => (
          <Segment key={k.value} value={k.value}>
            {k.label}
          </Segment>
        ))}
      </SegmentGroup>

      {source.kind === "microphone" && (
        <Select
          size="sm"
          radius="sm"
          aria-label="Input device"
          items={deviceItems}
          labelKey="label"
          valueKey="id"
          value={source.device ?? ""}
          isDisabled={busy}
          onChange={(key) => source.setDevice(key ? String(key) : null)}
          className="min-w-48"
        />
      )}
      {source.kind === "file" && (
        <label className="text-[13px] text-text-light cursor-pointer">
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            disabled={busy}
            onChange={(e) => source.setFile(e.target.files?.[0] ?? null)}
          />
          <span className="underline decoration-dotted underline-offset-4">
            {source.file ? source.file.name : "choose an audio file…"}
          </span>
        </label>
      )}
      {source.kind === "tone" && (
        <Select
          size="sm"
          radius="sm"
          aria-label="Tone frequency"
          items={[220, 440, 1000, 3000].map((hz) => ({
            id: String(hz),
            label: `${hz} Hz`,
          }))}
          labelKey="label"
          valueKey="id"
          value={String(source.toneHz)}
          isDisabled={busy}
          onChange={(key) => source.setToneHz(Number(key ?? 440))}
          className="min-w-28"
        />
      )}

      <div className="ml-auto flex items-center gap-2">
        {source.error && (
          <span className="text-2xs text-red-600 max-w-72 truncate">
            {source.error}
          </span>
        )}
        {busy ? (
          <Button
            size="sm"
            radius="sm"
            variant="outline"
            color="neutral"
            prepend={<IconPlayerStop size={14} />}
            onPress={source.stop}
          >
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            radius="sm"
            variant="solid"
            color="neutral"
            isLoading={source.starting}
            prepend={
              source.kind === "microphone" ? (
                <IconMicrophone size={14} />
              ) : (
                <IconWaveSine size={14} />
              )
            }
            onPress={() => void source.start()}
          >
            Start
          </Button>
        )}
      </div>
    </div>
  );
}
