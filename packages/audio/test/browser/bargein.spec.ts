import { expect, test } from "@playwright/test";
import { PAGE_HELPERS, gesture } from "./page-helpers";

/**
 * Slice 4 — barge-in, against the VOICE fixture: the "user" speaks every
 * few seconds, so a long assistant reply will get talked over.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.ready);
});

test("a human talking over playback stops it and emits barge-in; the reply reports completed:false", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const E = window.A.createEngine();
    window.E = E;
    const events = [];
    E.on("barge-in", (e) => events.push({ e: "barge-in", at: e.at, t: e.t }));
    E.player.on("interrupted", (r) => events.push({ e: "interrupted", ...r }));
    E.vad.on("speech-start", (e) => events.push({ e: "speech-start", at: e.at }));
    await E.mic.open();
    const reply = await E.player.play(toneWav(8000, 220, 24000, -12)); // an 8 s reply; the fixture interrupts within ~4 s
    return { reply, events, player: E.player.state };
  })()`)) as { reply: { completed: boolean; playedMs: number }; events: { e: string; at?: number; t?: number; completed?: boolean }[]; player: string };
  expect(r.reply.completed).toBe(false);
  expect(r.reply.playedMs).toBeLessThan(6000);
  expect(r.player).toBe("idle");
  const barge = r.events.find((e) => e.e === "barge-in");
  const start = r.events.find((e) => e.e === "speech-start");
  expect(barge).toBeDefined();
  expect(barge!.at).toBe(start!.at); // the same onset the VAD reported
  expect(r.events.some((e) => e.e === "interrupted" && e.completed === false)).toBe(true);
});

test("bargeIn: false leaves playback alone even though speech is detected", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const E = window.A.createEngine({ bargeIn: false });
    let starts = 0, barges = 0;
    E.vad.on("speech-start", () => starts++);
    E.on("barge-in", () => barges++);
    await E.mic.open();
    const reply = await E.player.play(toneWav(4500, 220, 24000, -12));
    E.close();
    return { completed: reply.completed, starts, barges };
  })()`)) as { completed: boolean; starts: number; barges: number };
  expect(r.completed).toBe(true);
  expect(r.starts).toBeGreaterThan(0);
  expect(r.barges).toBe(0);
});
