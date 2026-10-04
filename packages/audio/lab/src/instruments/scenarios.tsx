import { Button, Loader, Tag } from "@parrot-co/parrot-ui";
import { IconPlayerPlay } from "@tabler/icons-react";
import { useState } from "react";
import { Card, SectionHeader } from "@/components/card";
import { useLab } from "@/lib/engine";
import { runScenario, SCENARIOS, type Outcome } from "@/lib/scenarios";

type Row = (Outcome & { ms: number }) | "running" | null;

/** The browser test suite, in the page: every attack from the teardown against a live engine. */
export function ScenarioRunner() {
  const { note } = useLab();
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [runningAll, setRunningAll] = useState(false);

  async function runOne(key: string) {
    const s = SCENARIOS.find((x) => x.key === key);
    if (!s) return;
    setRows((r) => ({ ...r, [key]: "running" }));
    const out = await runScenario(s, note);
    setRows((r) => ({ ...r, [key]: out }));
    note(`scenario ${s.key}: ${out.ok ? "pass" : "FAIL"} — ${out.detail}`);
  }

  async function runAll() {
    setRunningAll(true);
    setRows({});
    for (const s of SCENARIOS) await runOne(s.key);
    setRunningAll(false);
  }

  const done = Object.values(rows).filter((r): r is Outcome & { ms: number } => r !== null && r !== "running");
  const passed = done.filter((r) => r.ok).length;

  return (
    <Card>
      <SectionHeader
        title="Every attack from the teardown, against a live engine"
        description="Scratch engines fed synthetic speech through mic.open({ stream }) — no microphone, no backend. Same assertions as the CI browser suite."
        action={
          <div className="flex items-center gap-3">
            {done.length > 0 && (
              <Tag size="sm" variant="pastel" radius="full" color={passed === done.length ? "lime" : "pink"} className="font-mono text-[11px] px-2">
                {passed}/{done.length} passed
              </Tag>
            )}
            <Button size="sm" radius="sm" variant="solid" color="neutral" isLoading={runningAll} prepend={<IconPlayerPlay size={14} />} onPress={() => void runAll()}>
              run all
            </Button>
          </div>
        }
      />
      <div className="flex flex-col">
        {SCENARIOS.map((s) => {
          const r = rows[s.key] ?? null;
          return (
            <div key={s.key} className="grid grid-cols-[88px_1fr_auto] items-center gap-3 py-2 border-b border-border-subtle last:border-0">
              <div>
                {r === "running" ? (
                  <Loader size="xs" />
                ) : r ? (
                  <Tag size="sm" variant="pastel" radius="sm" color={r.ok ? "lime" : "pink"} className="font-mono text-[11px] uppercase px-1.5 w-16 justify-center">
                    {r.ok ? "pass" : "fail"}
                  </Tag>
                ) : (
                  <Tag size="sm" variant="outline" radius="sm" color="neutral" className="font-mono text-[11px] uppercase px-1.5 w-16 justify-center">
                    —
                  </Tag>
                )}
              </div>
              <div className="min-w-0">
                <div className="text-[13px] text-text-dark">{s.title}</div>
                <div className="text-2xs text-text-light truncate">
                  {s.finding}
                  {r && r !== "running" && <span className="readout ml-2">· {r.detail} · {r.ms.toFixed(0)} ms</span>}
                </div>
              </div>
              <Button size="xs" radius="sm" variant="ghost" color="neutral" isDisabled={runningAll || r === "running"} onPress={() => void runOne(s.key)}>
                run
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
