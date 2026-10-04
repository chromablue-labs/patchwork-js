import { useEffect, useRef } from "react";

/** A static waveform of peaks, mirrored around the centre line. */
export function Waveform({ peaks, height = 64, className }: { peaks: Float32Array | null; height?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    canvas.width = w * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = getComputedStyle(canvas).color;
    if (!peaks) return;
    const n = peaks.length;
    const slot = w / n;
    for (let i = 0; i < n; i++) {
      const h = Math.max(1, peaks[i] * height);
      ctx.fillRect(i * slot, (height - h) / 2, Math.max(1, slot - 1), h);
    }
  }, [peaks, height]);
  return <canvas ref={ref} className={className ?? "w-full text-text-dark"} style={{ height }} />;
}
