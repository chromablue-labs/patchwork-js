import { describe, expect, test } from "bun:test";
import { Emitter } from "../../src/events";

type Events = { frame: { rms: number }; ping: string };

describe("Emitter", () => {
  test("delivers and unsubscribes", () => {
    const bus = new Emitter<Events>();
    const seen: number[] = [];
    const off = bus.on("frame", (frame) => seen.push(frame.rms));
    bus.emit("frame", { rms: 0.2 });
    off();
    bus.emit("frame", { rms: 0.9 });
    expect(seen).toEqual([0.2]);
  });

  test("clear drops every listener", () => {
    const bus = new Emitter<Events>();
    let n = 0;
    bus.on("ping", () => {
      n += 1;
    });
    bus.clear();
    bus.emit("ping", "x");
    expect(n).toBe(0);
  });
});
