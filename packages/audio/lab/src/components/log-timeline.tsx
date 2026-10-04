import { Timeline } from "@parrot-co/parrot-ui";
import clsx from "clsx";
import type { LogEntry } from "@/lib/engine";

const DOT: Record<LogEntry["kind"], string> = {
  state: "bg-amber-400",
  mic: "bg-lime-500",
  player: "bg-violet-500",
  vad: "bg-sky-500",
  error: "bg-red-500",
  "barge-in": "bg-pink-500",
  "take-limit": "bg-orange-500",
  devices: "bg-neutral-400",
  lab: "bg-neutral-300",
};

function Row({ entry, t0 }: { entry: LogEntry; t0: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className={clsx("text-[13px] truncate", entry.kind === "error" ? "text-red-600" : "text-text-dark")}>{entry.text}</span>
      <span className="shrink-0 readout">
        {entry.t !== null ? `${(entry.t / 1000).toFixed(2)}s` : `+${((entry.at - t0) / 1000).toFixed(2)}s`}
      </span>
    </div>
  );
}

/** Every transition, newest first, on the audio clock where there was one. */
export function LogTimeline({ entries, limit = 60 }: { entries: LogEntry[]; limit?: number }) {
  const rows = entries.slice(-limit).reverse();
  const t0 = entries[0]?.at ?? 0;
  if (rows.length === 0) return <div className="text-[13px] text-text-light py-4">Nothing yet.</div>;
  return (
    <Timeline<LogEntry>
      items={rows}
      getIndicator={(e) => <span className={clsx("block size-2 rounded-full", DOT[e.kind])} />}
      render={(e) => <Row entry={e} t0={t0} />}
    />
  );
}
