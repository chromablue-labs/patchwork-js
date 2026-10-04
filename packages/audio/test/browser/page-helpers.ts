import type { Page } from "@playwright/test";

/** Run `expr` inside a trusted click on the harness button, so the browser grants user activation. */
export async function gesture(page: Page, expr: string): Promise<unknown> {
  await page.evaluate((src) => {
    window.gesture = new Function(`return (${src})`) as () => unknown;
  }, expr);
  await page.click("#gesture");
  return page.evaluate(() => window.gestureResult);
}

/**
 * Page-side helpers, injected as source into evaluate bodies:
 *   wav(i16, rate)            — wrap Int16 PCM in a WAV header → ArrayBuffer
 *   tone(ms, hz, rate, db)    — an Int16Array sine at a given dBFS
 *   toneWav(ms, hz, rate, db) — the two together
 *   sleep(ms)
 */
export const PAGE_HELPERS = `
  const wav = (i16, rate = 16000) => {
    const b = new ArrayBuffer(44 + i16.length * 2), v = new DataView(b);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + i16.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, i16.length * 2, true);
    new Int16Array(b, 44).set(i16);
    return b;
  };
  const tone = (ms, hz = 440, rate = 24000, db = -12) => {
    const n = Math.round((rate * ms) / 1000), out = new Int16Array(n), amp = Math.pow(10, db / 20) * Math.SQRT2 * 32767;
    for (let i = 0; i < n; i++) {
      const edge = Math.min(1, i / (rate * 0.005), (n - 1 - i) / (rate * 0.005));
      out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp * edge);
    }
    return out;
  };
  const toneWav = (ms, hz, rate = 24000, db = -12) => wav(tone(ms, hz, rate, db), rate);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;
