import { expect, test } from "@playwright/test";
import { PAGE_HELPERS, gesture } from "./page-helpers";

/**
 * Slice 5 — Display. The microphone plays the VOICE fixture (speech at
 * 0.6–1.6 s and 3.0–3.4 s of every 4 s), so the mic tap has something to show;
 * the player tests never open the mic, so their only source is the tone.
 */
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    window.log = [];
    window.errors = [];
    window.E = window.A.createEngine();
    window.E.on("error", (e) => window.errors.push({ code: e.code, recoverable: e.recoverable, message: e.message }));
    window.E.levels.on("active", (a) => window.log.push(`active:${a}`));
  });
});

test("a frame is small and explicit: no PCM inside, pcm() on demand, time-based bars", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const before = window.E.levels.read();
    const p = window.E.player.play(toneWav(400, 440));
    await sleep(200);
    const f = window.E.levels.read();
    const pcm = window.E.levels.pcm();
    const again = window.E.levels.pcm();
    await p;
    return {
      beforeKeys: Object.keys(before), keys: Object.keys(f), micKeys: Object.keys(f.mic),
      bars: f.bars.length, hopMs: f.hopMs, hopProgress: f.hopProgress, t: f.t, level: f.level, rms: f.rms, peak: f.peak,
      td: pcm.timeDomain.length, fq: pcm.frequency.length, memoised: pcm === again,
      tdPeak: Math.max(...Array.from(pcm.timeDomain).map(Math.abs)),
      beforeActive: window.E.levels.active,
    };
  })()`)) as Record<string, number | boolean | string[]>;
  expect(r.keys).toEqual(["t", "rms", "peak", "level", "speaking", "bars", "hopMs", "hopProgress", "mic", "player"]);
  expect(r.micKeys).toEqual(["rms", "peak", "level"]);
  expect(r.bars).toBe(44); // 700 / 16
  expect(r.hopMs).toBe(16);
  expect(r.hopProgress as number).toBeGreaterThanOrEqual(0);
  expect(r.hopProgress as number).toBeLessThan(1);
  expect(r.t as number).toBeGreaterThan(0);
  expect(r.level as number).toBeGreaterThan(0.4); // a −12 dBFS tone sits at ~0.76
  expect(r.rms as number).toBeGreaterThan(0.1);
  expect(r.peak as number).toBeGreaterThan(r.rms as number);
  expect(r.td).toBe(2048);
  expect(r.fq).toBe(1024);
  expect(r.memoised).toBe(true);
  expect(r.tdPeak as number).toBeGreaterThan(0.1);
});

test("the loop idles: no frames before anything feeds it, frames while playing, and it stops after the strip drains", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    let frames = 0;
    const off = window.E.levels.on("frame", () => frames++);
    await sleep(300);
    const beforeAny = frames;
    const activeBefore = window.E.levels.active;
    await window.E.player.play(toneWav(300, 440));
    const during = frames;
    const stoppedAt = performance.now();
    // drain: historyMs (700) + releaseMs (120) + 200 of grace
    let lastFrames = frames;
    let idleAt = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      if (frames === lastFrames) { idleAt = performance.now() - stoppedAt; break; }
      lastFrames = frames;
    }
    const tail = window.E.levels.read();
    off();
    return { beforeAny, activeBefore, during, idleAt, activeAfter: window.E.levels.active, log: window.log, tailMax: Math.max(...tail.bars) };
  })()`)) as { beforeAny: number; activeBefore: boolean; during: number; idleAt: number | null; activeAfter: boolean; log: string[]; tailMax: number };
  expect(r.beforeAny).toBe(0);
  expect(r.activeBefore).toBe(false);
  expect(r.during).toBeGreaterThan(8);
  expect(r.idleAt).not.toBeNull();
  expect(r.idleAt as number).toBeLessThan(2000);
  expect(r.activeAfter).toBe(false);
  expect(r.log).toEqual(["active:true", "active:false"]);
  expect(r.tailMax).toBeLessThan(0.05); // the strip emptied
});

test("on('frame', fn, { hz }) rate-limits on the audio clock; the unlimited listener runs at display rate", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    let fast = 0, slow = 0;
    window.E.levels.on("frame", () => fast++);
    window.E.levels.on("frame", () => slow++, { hz: 10 });
    await window.E.player.play(toneWav(1000, 440));
    let bad = null;
    try { window.E.levels.on("frame", () => {}, { hz: 0 }); } catch (e) { bad = e.code; }
    return { fast, slow, bad };
  })()`)) as { fast: number; slow: number; bad: string | null };
  expect(r.fast).toBeGreaterThan(30);
  expect(r.slow).toBeGreaterThanOrEqual(8);
  expect(r.slow).toBeLessThanOrEqual(13);
  expect(r.bad).toBe("invalid_option");
});

test("per-source: the mic tap sees the voice and not the tone; the player tap sees the tone and not the voice", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    // 1. mic only
    await window.E.mic.open();
    let micMax = 0, playerWhileMic = 0, spoke = false;
    const off = window.E.levels.on("frame", (f) => {
      micMax = Math.max(micMax, f.mic.level);
      playerWhileMic = Math.max(playerWhileMic, f.player.level);
      if (f.speaking) spoke = true;
    });
    await sleep(2200); // covers the 0.6–1.6 s utterance wherever the loop is
    off();
    window.E.mic.close();
    await sleep(1200); // drain
    // 2. player only
    let playerMax = 0, micWhilePlayer = 0, mixMax = 0;
    const off2 = window.E.levels.on("frame", (f) => {
      playerMax = Math.max(playerMax, f.player.level);
      micWhilePlayer = Math.max(micWhilePlayer, f.mic.level);
      mixMax = Math.max(mixMax, f.level);
    });
    await window.E.player.play(toneWav(500, 440));
    off2();
    return { micMax, playerWhileMic, spoke, playerMax, micWhilePlayer, mixMax };
  })()`)) as Record<string, number | boolean>;
  expect(r.micMax as number).toBeGreaterThan(0.3);
  expect(r.playerWhileMic).toBe(0);
  expect(r.spoke).toBe(true);
  expect(r.playerMax as number).toBeGreaterThan(0.5);
  expect(r.micWhilePlayer).toBe(0);
  expect(Math.abs((r.mixMax as number) - (r.playerMax as number))).toBeLessThan(0.05);
});

test("the strip holds 0.7 s: after a 900 ms tone every slot is lit, and attack/release smooth on elapsed time", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const levels = [];
    const off = window.E.levels.on("frame", (f) => levels.push({ t: f.t, level: f.level }));
    const p = window.E.player.play(toneWav(900, 440));
    await sleep(850);
    const full = window.E.levels.read();
    await p;
    off();
    // rise time: first frame above 0.5 relative to the first frame above 0.05
    const first = levels.find((l) => l.level > 0.05), high = levels.find((l) => l.level > 0.5);
    return { lit: Array.from(full.bars).filter((v) => v > 0.4).length, n: full.bars.length, riseMs: high && first ? high.t - first.t : null, samples: levels.length };
  })()`)) as { lit: number; n: number; riseMs: number | null; samples: number };
  expect(r.n).toBe(44);
  expect(r.lit).toBeGreaterThanOrEqual(42);
  expect(r.riseMs).not.toBeNull();
  expect(r.riseMs as number).toBeLessThan(120); // attackMs 40 → ~0.5 in one time constant
});

test("levels.options applies live and is validated: history resizes, fftSize changes pcm(), bad values throw invalid_option", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const p = window.E.player.play(toneWav(400, 440));
    await sleep(100);
    window.E.levels.options = { historyMs: 320, hopMs: 20 };
    const a = window.E.levels.read();
    window.E.levels.options = { fftSize: 512 };
    await sleep(50);
    const pcm = window.E.levels.pcm();
    let bad = null;
    try { window.E.levels.options = { fftSize: 1000 }; } catch (e) { bad = e.code; }
    await p;
    return { bars: a.bars.length, hopMs: a.hopMs, td: pcm.timeDomain.length, bad, errors: window.errors.map((e) => e.code), kept: window.E.levels.options };
  })()`)) as { bars: number; hopMs: number; td: number; bad: string | null; errors: string[]; kept: Record<string, number> };
  expect(r.bars).toBe(16);
  expect(r.hopMs).toBe(20);
  expect(r.td).toBe(512);
  expect(r.bad).toBe("invalid_option");
  expect(r.errors).toEqual(["invalid_option"]);
  expect(r.kept).toMatchObject({ historyMs: 320, hopMs: 20, fftSize: 512 });
});

test("renderers: SVG bars are retained rects, canvas bars paint pixels, the orb grows with level", async ({ page }) => {
  const r = (await gesture(page, `(async () => { ${PAGE_HELPERS}
    const box = (tag) => {
      const e = tag === "canvas" ? document.createElement("canvas") : document.createElementNS("http://www.w3.org/2000/svg", "svg");
      e.style.cssText = "display:block;width:220px;height:44px;color:rgb(10,20,30)";
      document.body.appendChild(e);
      return e;
    };
    const svg = box("svg"), glideSvg = box("svg"), canvas = box("canvas"), orbSvg = box("svg"), orbCanvas = box("canvas");
    orbSvg.style.height = orbCanvas.style.height = "120px";
    const { Bars, Orb } = window.VZ;
    const bars = new Bars.Svg(svg).connect(window.E.levels);
    const glide = new Bars.Svg(glideSvg, { glide: true, enterFrom: "right" }).connect(window.E.levels);
    const cbars = new Bars.Canvas(canvas).connect(window.E.levels);
    const orb = new Orb.Svg(orbSvg).connect(window.E.levels);
    const corb = new Orb.Canvas(orbCanvas, { color: "rgb(200,0,0)" }).connect(window.E.levels);
    const idleR = +orbSvg.querySelectorAll("circle")[1].getAttribute("r");
    const rectsBefore = svg.querySelectorAll("rect");
    const firstRect = rectsBefore[0];
    const p = window.E.player.play(toneWav(900, 440));
    await sleep(800);
    const rects = [...svg.querySelectorAll("rect")];
    const heights = rects.map((q) => +q.getAttribute("height"));
    const loudR = +orbSvg.querySelectorAll("circle")[1].getAttribute("r");
    const ctx = canvas.getContext("2d");
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) painted++;
    const opx = orbCanvas.getContext("2d").getImageData(0, 0, orbCanvas.width, orbCanvas.height).data;
    let red = 0; for (let i = 0; i < opx.length; i += 4) if (opx[i] > 150 && opx[i + 3] > 200) red++;
    await p;
    const gl = glideSvg.querySelectorAll("rect").length;
    for (const rr of [bars, glide, cbars, orb, corb]) rr.disconnect();
    return {
      count: rects.length, sameNode: rects[0] === firstRect, before: rectsBefore.length,
      minH: Math.min(...heights), maxH: Math.max(...heights), viewBox: svg.getAttribute("viewBox"),
      fill: svg.querySelector("g").getAttribute("fill"), gl, idleR, loudR,
      painted, canvasW: canvas.width, red,
    };
  })()`)) as Record<string, number | boolean | string>;
  expect(r.count).toBe(44);
  expect(r.before).toBe(44);
  expect(r.sameNode).toBe(true); // mutated in place, never re-created
  expect(r.viewBox).toBe("0 0 220 44");
  expect(r.fill).toBe("currentColor");
  expect(r.maxH as number).toBeGreaterThan(30);
  expect(r.gl).toBe(45); // the live bar
  expect(r.loudR as number).toBeGreaterThan((r.idleR as number) * 1.3);
  expect(r.painted as number).toBeGreaterThan(500);
  expect(r.canvasW as number).toBeGreaterThanOrEqual(220);
  expect(r.red as number).toBeGreaterThan(500);
});
