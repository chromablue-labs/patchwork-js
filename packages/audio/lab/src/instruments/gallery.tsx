import { NumberInput, Select, Switch, Button } from "@parrot-co/parrot-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bars, Orb, barGeometry, orbGeometry, type Renderer } from "@usepatchwork/audio/visualizers";
import type { BarGeometryOptions, OrbGeometryOptions } from "@usepatchwork/audio";
import { Card, Readout, ReadoutRow, SectionHeader } from "@/components/card";
import { useEngine } from "@/lib/engine";
import { useFrame } from "@/lib/hooks";
import { syntheticReply } from "@/lib/sources";

type Look = "bars" | "glide" | "orb";

function Pane({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 ${className ?? ""}`}>
      <div className="text-2xs font-medium text-text-light">{title}</div>
      <div className="rounded border border-border-subtle bg-surface-sunken p-3 text-text-dark">{children}</div>
    </div>
  );
}

/** Mounts one package renderer on a ref'd element and keeps it connected to the lab's levels. */
function useRenderer<E extends Element>(make: (el: E) => Renderer, deps: unknown[]) {
  const engine = useEngine();
  const ref = useRef<E>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = make(el).connect(engine.levels);
    return () => r.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, ...deps]);
  return ref;
}

export function VisualiserGallery() {
  const engine = useEngine();
  const frame = useFrame(20);
  const [bar, setBar] = useState<BarGeometryOptions>({ gap: 2, mirrored: true, enterFrom: "left" });
  const [count, setCount] = useState<number | undefined>(undefined);
  const [orb, setOrb] = useState<OrbGeometryOptions>({ idleBreath: true });
  const barOpts = useMemo(() => ({ ...bar, count }), [bar, count]);
  const key = JSON.stringify({ barOpts, orb });

  const barsCanvas = useRenderer<HTMLCanvasElement>((el) => new Bars.Canvas(el, barOpts), [key]);
  const barsSvg = useRenderer<SVGSVGElement>((el) => new Bars.Svg(el, barOpts), [key]);
  const glideCanvas = useRenderer<HTMLCanvasElement>((el) => new Bars.Canvas(el, { ...barOpts, glide: true }), [key]);
  const glideSvg = useRenderer<SVGSVGElement>((el) => new Bars.Svg(el, { ...barOpts, glide: true }), [key]);
  const orbCanvas = useRenderer<HTMLCanvasElement>((el) => new Orb.Canvas(el, orb), [key]);
  const orbSvg = useRenderer<SVGSVGElement>((el) => new Orb.Svg(el, orb), [key]);

  // A consumer drawing from Bar[] itself — React owns these rects.
  const reactBars = frame ? barGeometry(frame, 320, 44, { ...barOpts, glide: true }) : [];
  const reactOrb = frame ? orbGeometry(frame, 120, 120, orb) : null;

  const looks: { look: Look; label: string; canvas: React.ReactNode; svg: React.ReactNode }[] = [
    { look: "bars", label: "Bars — fixed slots", canvas: <canvas ref={barsCanvas} className="block w-full h-11" />, svg: <svg ref={barsSvg} className="block w-full h-11" /> },
    { look: "glide", label: "Gliding bars — travel across", canvas: <canvas ref={glideCanvas} className="block w-full h-11" />, svg: <svg ref={glideSvg} className="block w-full h-11 overflow-hidden" /> },
    { look: "orb", label: "Orb — breathes when idle, hue by who", canvas: <canvas ref={orbCanvas} className="block w-full h-32" />, svg: <svg ref={orbSvg} className="block w-full h-32" /> },
  ];

  return (
    <>
      <Card>
        <SectionHeader
          title="Three looks, canvas and SVG, one levels"
          description="Every pane is fed by the same audio.levels. Geometry is the product; the renderers are loops."
          action={
            <Button size="xs" radius="sm" variant="outline" color="neutral" onPress={() => void engine.player.play(syntheticReply(24000, 3)).catch(() => undefined)}>
              play a reply (lights the player tap)
            </Button>
          }
        />
        <div className="grid gap-5 md:grid-cols-2">
          {looks.map((l) => (
            <div key={l.look} className="contents">
              <Pane title={`${l.label} · canvas`}>{l.canvas}</Pane>
              <Pane title={`${l.label} · svg`}>{l.svg}</Pane>
            </div>
          ))}
          <Pane title="Your own renderer · React from barGeometry()">
            <svg viewBox="0 0 320 44" className="block w-full h-11 overflow-hidden">
              {reactBars.map((b, i) => (
                <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={b.r} fill={frame && frame.player.level > frame.mic.level ? "#8b5cf6" : "#0ea5e9"} />
              ))}
            </svg>
          </Pane>
          <Pane title="Your own renderer · React from orbGeometry()">
            <svg viewBox="0 0 120 120" className="block h-32 mx-auto">
              {reactOrb && <circle cx={reactOrb.cx} cy={reactOrb.cy} r={reactOrb.r} fill={`hsl(${reactOrb.hue.toFixed(0)} 70% 55%)`} />}
            </svg>
            <div className="readout text-center mt-1">who: {reactOrb?.who ?? "—"} · hue {reactOrb ? reactOrb.hue.toFixed(0) : "—"}</div>
          </Pane>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionHeader title="Look options" description="Passed to the geometry; the renderers just draw what comes back." />
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-3">
              <NumberInput size="sm" appearance="outline" label="gap (px)" value={bar.gap ?? 2} minValue={0} onChange={(v) => Number.isFinite(v) && setBar((b) => ({ ...b, gap: v }))} />
              <NumberInput size="sm" appearance="outline" label="count (slots)" value={count ?? (frame?.bars.length ?? 44)} minValue={1} onChange={(v) => Number.isFinite(v) && setCount(v)} />
              <Select size="sm" radius="sm" label="enterFrom" aria-label="enterFrom" items={[{ id: "left", label: "left" }, { id: "right", label: "right" }]} labelKey="label" valueKey="id" value={bar.enterFrom ?? "left"} onChange={(k) => k && setBar((b) => ({ ...b, enterFrom: String(k) as "left" | "right" }))} />
            </div>
            <Switch size="sm" isSelected={bar.mirrored ?? true} onChange={(v) => setBar((b) => ({ ...b, mirrored: v }))}>
              mirrored (grow from the centre line)
            </Switch>
            <Switch size="sm" isSelected={orb.idleBreath ?? true} onChange={(v) => setOrb((o) => ({ ...o, idleBreath: v }))}>
              orb idleBreath
            </Switch>
            <p className="text-2xs text-text-light">prefers-reduced-motion turns gliding into fixed slots and stops the breath — try it in your OS settings.</p>
          </div>
        </Card>
        <Card>
          <SectionHeader title="The frame" description="~400 bytes at up to display rate. No PCM inside — that is behind levels.pcm()." />
          <ReadoutRow>
            <Readout label="level (mix)" value={frame ? frame.level.toFixed(2) : "—"} />
            <Readout label="rms / peak" value={frame ? `${frame.rms.toFixed(3)} / ${frame.peak.toFixed(3)}` : "—"} />
            <Readout label="mic.level" value={frame ? frame.mic.level.toFixed(2) : "—"} />
            <Readout label="player.level" value={frame ? frame.player.level.toFixed(2) : "—"} />
            <Readout label="speaking" value={frame ? String(frame.speaking) : "—"} />
            <Readout label="bars" value={frame ? `${frame.bars.length} × ${frame.hopMs} ms` : "—"} />
            <Readout label="hopProgress" value={frame ? frame.hopProgress.toFixed(2) : "—"} />
            <Readout label="levels.active" value={String(engine.levels.active)} />
          </ReadoutRow>
        </Card>
      </div>
    </>
  );
}
