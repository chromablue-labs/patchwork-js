import { Tag } from "@parrot-co/parrot-ui";
import type { ComponentProps } from "react";
import type { EngineState, MicState, PlayerState } from "@usepatchwork/audio";

type TagColor = NonNullable<ComponentProps<typeof Tag>["color"]>;

const ENGINE: Record<EngineState, TagColor> = {
  locked: "neutral",
  ready: "lime",
  interrupted: "orange",
  closed: "neutral",
};
const MIC: Record<MicState, TagColor> = {
  unavailable: "neutral",
  idle: "neutral",
  requesting: "amber",
  ready: "lime",
  recording: "pink",
  streaming: "sky",
  denied: "red",
  lost: "red",
};
const PLAYER: Record<PlayerState, TagColor> = {
  idle: "neutral",
  playing: "violet",
};

export function StateTag({
  kind,
  state,
}: {
  kind: "engine" | "mic" | "player";
  state: string;
}) {
  const color =
    (kind === "engine"
      ? ENGINE[state as EngineState]
      : kind === "mic"
        ? MIC[state as MicState]
        : PLAYER[state as PlayerState]) ?? "neutral";
  return (
    <Tag
      size="md"
      variant="pastel"
      radius="md"
      color={color}
      className="font-mono text-[11px] font-medium uppercase px-2 gap-1.5"
    >
      <span className="normal-case">{kind}</span>
      {state}
    </Tag>
  );
}
