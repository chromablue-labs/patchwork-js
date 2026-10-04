import { Button, IconButton } from "@parrot-co/parrot-ui";
import {
  IconActivityHeartbeat,
  IconAdjustmentsHorizontal,
  IconArrowsExchange,
  IconChartBar,
  IconChecklist,
  IconLockOpen,
  IconMicrophone2,
  IconMoon,
  IconPlayerPlay,
  IconSun,
  IconWaveSine,
  type Icon,
} from "@tabler/icons-react";
import clsx from "clsx";
import { useEffect, useState, type ComponentType } from "react";
import { PageBody, PageHeader } from "@/components/page";
import { SourceBar } from "@/components/source-bar";
import { StateTag } from "@/components/state-tag";
import { useEngine, useEngineEvent } from "@/lib/engine";
import { useThemeMode } from "@/lib/theme";
import { LifecycleConsole } from "@/instruments/lifecycle";
import { TakeRecorder } from "@/instruments/take";
import { StreamInspector } from "@/instruments/stream";
import { PlayerInstrument } from "@/instruments/player";
import { VadTuner } from "@/instruments/vad";
import { VisualiserGallery } from "@/instruments/gallery";
import { TurnSimulator } from "@/instruments/turn";
import { ScenarioRunner } from "@/instruments/scenarios";

type Instrument = { key: string; label: string; icon: Icon; section: string; component: ComponentType };

/** One instrument per concern (spec §13). */
const INSTRUMENTS: Instrument[] = [
  { key: "lifecycle", label: "Lifecycle", icon: IconActivityHeartbeat, section: "Engine", component: LifecycleConsole },
  { key: "take", label: "Take recorder", icon: IconMicrophone2, section: "Transport", component: TakeRecorder },
  { key: "stream", label: "Stream inspector", icon: IconArrowsExchange, section: "Transport", component: StreamInspector },
  { key: "player", label: "Player", icon: IconPlayerPlay, section: "Transport", component: PlayerInstrument },
  { key: "vad", label: "VAD tuner", icon: IconAdjustmentsHorizontal, section: "Sensing", component: VadTuner },
  { key: "gallery", label: "Visualisers", icon: IconChartBar, section: "Display", component: VisualiserGallery },
  { key: "turn", label: "Turn simulator", icon: IconWaveSine, section: "Scenarios", component: TurnSimulator },
  { key: "scenarios", label: "Scenario runner", icon: IconChecklist, section: "Scenarios", component: ScenarioRunner },
];

function useHashRoute(): [string, (key: string) => void] {
  const read = () => location.hash.replace(/^#\/?/, "") || INSTRUMENTS[0].key;
  const [key, setKey] = useState(read);
  useEffect(() => {
    const onHash = () => setKey(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return [key, (next) => (location.hash = `#/${next}`)];
}

function Sidebar({ active, onSelect }: { active: string; onSelect: (key: string) => void }) {
  const { colorScheme, setMode } = useThemeMode();
  const sections = [...new Set(INSTRUMENTS.map((i) => i.section))];
  return (
    <div className="flex flex-col w-full justify-between h-screen border-r border-border-subtle bg-surface">
      <div className="flex flex-col gap-6">
        <div className="head flex h-14 items-center justify-between border-b border-border-subtle px-4">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold text-text-dark tracking-tight">Patchwork</span>
            <span className="text-2xs font-medium uppercase tracking-wide text-text-light">Audio Lab</span>
          </div>
          <IconButton
            variant="ghost"
            size="sm"
            type="button"
            aria-label={colorScheme === "dark" ? "Light theme" : "Dark theme"}
            onPress={() => setMode(colorScheme === "dark" ? "light" : "dark")}
          >
            {colorScheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
          </IconButton>
        </div>
        <nav className="flex flex-col gap-5 px-3">
          {sections.map((section) => (
            <div key={section} className="flex flex-col gap-0.5">
              <div className="px-1 pb-1 text-2xs font-medium text-text-muted uppercase tracking-wide">{section}</div>
              {INSTRUMENTS.filter((i) => i.section === section).map((i) => {
                const Icon = i.icon;
                const isActive = i.key === active;
                return (
                  <button
                    key={i.key}
                    type="button"
                    onClick={() => onSelect(i.key)}
                    className={clsx(
                      "flex items-center gap-2 rounded px-1 py-1 text-[13px] text-text-light hover:bg-surface-hover text-left",
                      isActive && "text-text-dark! bg-surface-hover",
                    )}
                  >
                    <span className="flex size-6 items-center justify-center shrink-0">
                      <Icon stroke={2} size={18} />
                    </span>
                    <span className="font-medium">{i.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </div>
      <div className="px-4 py-4 text-2xs text-text-muted leading-relaxed">
        The engine's own instrument panel. Every number comes through the public surface —{" "}
        <span className="font-mono">audio.on(…)</span>.
      </div>
    </div>
  );
}

function UnlockButton() {
  const engine = useEngine();
  const state = useEngineEvent("state");
  if (state === "ready") return null;
  return (
    <Button size="xs" radius="sm" variant="solid" color="neutral" prepend={<IconLockOpen size={14} />} onPress={() => void engine.unlock().catch(() => undefined)}>
      Unlock audio
    </Button>
  );
}

export function App() {
  const [active, setActive] = useHashRoute();
  const instrument = INSTRUMENTS.find((i) => i.key === active) ?? INSTRUMENTS[0];
  const Body = instrument.component;
  const engineState = useEngineEvent("state");
  const micState = useEngineEvent("mic");
  const playerState = useEngineEvent("player");

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="shrink-0 w-60">
        <Sidebar active={instrument.key} onSelect={setActive} />
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto bg-surface-raised">
        <PageHeader
          title={instrument.label}
          actions={
            <>
              <StateTag kind="engine" state={engineState} />
              <StateTag kind="mic" state={micState} />
              <StateTag kind="player" state={playerState} />
              <UnlockButton />
            </>
          }
        />
        <PageBody>
          <SourceBar />
          <Body />
        </PageBody>
      </main>
    </div>
  );
}
