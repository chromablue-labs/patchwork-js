import { Button, Tag, Timeline } from "@parrot-co/parrot-ui";
import { IconPlayerPlay } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { ApiConfigCard } from "@/components/api-config";
import { Card, Empty, Readout, ReadoutRow, SectionHeader } from "@/components/card";
import { readApiConfig, speak } from "@/lib/api";
import { useEngine, useLab } from "@/lib/engine";
import { fmtMs } from "@/lib/hooks";
import { useSource } from "@/lib/source-context";
import { syntheticReply } from "@/lib/sources";

type Step = { at: number; who: "assistant" | "user" | "engine"; text: string };

/**
 * A scripted exchange: the assistant speaks, the user talks over it, barge-in
 * fires, the user's turn ends, the next reply plays. Every step is stamped on
 * the audio clock so the *feel* of turn-taking can be tuned end to end without
 * running the agent loop.
 */
export function TurnSimulator() {
  const engine = useEngine();
  const { options, setOptions, note } = useLab();
  const source = useSource();
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [measures, setMeasures] = useState<{ reaction: number | null; replyAfterTurn: number | null; playedBeforeCut: number | null; mode: string } | null>(null);
  const [, setApiTick] = useState(0);
  const api = readApiConfig();
  const abort = useRef(false);

  const now = () => (engine.hasContext ? engine.context.currentTime * 1000 : 0);
  const fullDuplex = options.bargeIn ?? true;

  async function reply(words: number, text: string): Promise<Blob> {
    if (api) {
      try {
        return (await speak(api, text)).blob;
      } catch (err) {
        note(`speak failed, using the synthetic reply: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return syntheticReply(24000, words);
  }

  async function run() {
    setRunning(true);
    abort.current = false;
    const log: Step[] = [];
    const push = (who: Step["who"], text: string) => {
      log.push({ at: now(), who, text });
      setSteps([...log]);
    };
    setSteps([]);
    setMeasures(null);
    let speechStartAt: number | null = null;
    let bargeAt: number | null = null;
    let turnEndT: number | null = null;
    const offs = [
      engine.vad.on("speech-start", (e) => {
        if (speechStartAt === null) speechStartAt = e.at;
        push("user", `starts talking (onset at ${e.at.toFixed(0)} ms, detector sure ${(e.t - e.at).toFixed(0)} ms later)`);
      }),
      engine.vad.on("speech-end", (e) => push("user", `pauses (at ${e.at.toFixed(0)} ms)`)),
      engine.vad.on("turn-end", (e) => {
        turnEndT = e.t;
        push("engine", `turn-end — ${engine.vad.options.turnEndMs} ms of silence since ${e.at.toFixed(0)} ms`);
      }),
      engine.on("barge-in", (e) => {
        bargeAt = now();
        push("engine", `barge-in — player stopped (${(bargeAt - e.at).toFixed(0)} ms after the onset)`);
      }),
    ];
    try {
      await engine.unlock();
      const first = await reply(14, "I can help with that. Let me walk you through the options we have, starting with the one most people pick, and then the alternatives, in case you would rather do it another way.");
      push("assistant", `starts a long reply (${fullDuplex ? "full duplex: mic keeps listening" : "half duplex: barge-in off"})`);
      const r1 = await engine.player.play(first);
      push("assistant", r1.completed ? "finishes the reply — nobody interrupted" : `is cut off after ${r1.playedMs.toFixed(0)} ms`);
      if (abort.current) return;
      // wait for the user's turn to end (they may still be talking)
      const deadline = performance.now() + 8000;
      while (turnEndT === null && performance.now() < deadline && !abort.current) await new Promise((r) => setTimeout(r, 50));
      if (turnEndT === null) push("engine", "no turn-end within 8 s — is the signal producing speech?");
      const second = await reply(3, "Got it. Here is the short version.");
      const t2 = now();
      push("assistant", "replies to what was said");
      const r2 = await engine.player.play(second);
      push("assistant", r2.completed ? "finishes" : `cut off again after ${r2.playedMs.toFixed(0)} ms`);
      setMeasures({
        reaction: bargeAt !== null && speechStartAt !== null ? bargeAt - speechStartAt : null,
        replyAfterTurn: turnEndT !== null ? t2 - turnEndT : null,
        playedBeforeCut: r1.completed ? null : r1.playedMs,
        mode: fullDuplex ? "full duplex" : "half duplex",
      });
    } finally {
      offs.forEach((off) => off());
      setRunning(false);
    }
  }

  const t0 = steps[0]?.at ?? 0;

  return (
    <>
      <Card>
        <SectionHeader
          title="A scripted exchange"
          description="Needs a signal that produces speech — synthetic voice does, every few seconds. With the API configured the replies are real ElevenLabs voice."
          action={
            <div className="flex gap-2">
              <Button size="sm" radius="sm" variant="outline" color="neutral" onPress={() => setOptions({ bargeIn: !fullDuplex })} isDisabled={running}>
                switch to {fullDuplex ? "half" : "full"} duplex
              </Button>
              {running ? (
                <Button size="sm" radius="sm" variant="solid" color="neutral" onPress={() => { abort.current = true; engine.player.stop(); }}>
                  abort
                </Button>
              ) : (
                <Button size="sm" radius="sm" variant="solid" color="neutral" prepend={<IconPlayerPlay size={14} />} isDisabled={!source.running} onPress={() => void run()}>
                  run the exchange
                </Button>
              )}
            </div>
          }
        />
        {steps.length === 0 ? (
          <Empty>{source.running ? "Run the exchange." : "Start a signal above first — synthetic voice is the one that talks back."}</Empty>
        ) : (
          <Timeline<Step>
            items={steps}
            getIndicator={(s) => <span className={`block size-2 rounded-full ${s.who === "assistant" ? "bg-violet-500" : s.who === "user" ? "bg-sky-500" : "bg-pink-500"}`} />}
            render={(s) => (
              <div className="flex items-baseline justify-between gap-3 py-0.5">
                <span className="text-[13px] text-text-dark">
                  <Tag size="sm" variant="outline" radius="sm" color="neutral" className="font-mono text-[10px] uppercase px-1 mr-2">
                    {s.who}
                  </Tag>
                  {s.text}
                </span>
                <span className="readout shrink-0">+{((s.at - t0) / 1000).toFixed(2)}s</span>
              </div>
            )}
          />
        )}
      </Card>
      <Card>
        <SectionHeader title="How it felt" description="The numbers that decide whether turn-taking feels natural." />
        {!measures ? (
          <Empty>Nothing measured yet.</Empty>
        ) : (
          <ReadoutRow>
            <Readout label="mode" value={measures.mode} />
            <Readout label="barge-in reaction (onset → stop)" value={fmtMs(measures.reaction)} unit="ms" />
            <Readout label="reply played before the cut" value={fmtMs(measures.playedBeforeCut)} unit="ms" />
            <Readout label="reply after turn-end" value={fmtMs(measures.replyAfterTurn)} unit="ms" />
          </ReadoutRow>
        )}
      </Card>
      <ApiConfigCard onChange={() => setApiTick((t) => t + 1)} />
    </>
  );
}
