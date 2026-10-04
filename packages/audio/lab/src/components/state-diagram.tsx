import clsx from "clsx";

export type DiagramNode = { id: string; label: string; x: number; y: number };
export type DiagramEdge = { from: string; to: string; label?: string; bend?: number };

const W = 112;
const H = 30;

/** A live state-machine diagram: boxes and arrows, the current state lit. Inline SVG from parrot's tokens. */
export function StateDiagram({ nodes, edges, active, width, height }: { nodes: DiagramNode[]; edges: DiagramEdge[]; active: string; width: number; height: number }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto text-text-light" style={{ maxWidth: width }}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      {edges.map((e, i) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        const ax = a.x + W / 2;
        const ay = a.y + H / 2;
        const bx = b.x + W / 2;
        const by = b.y + H / 2;
        // leave the boxes at their edges
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const exitX = Math.min(Math.abs((W / 2) / (ux || 1e-9)), Math.abs((H / 2) / (uy || 1e-9)));
        const sx = ax + ux * exitX;
        const sy = ay + uy * exitX;
        const ex = bx - ux * exitX;
        const ey = by - uy * exitX;
        const bend = e.bend ?? 0;
        const mx = (sx + ex) / 2 - uy * bend;
        const my = (sy + ey) / 2 + ux * bend;
        const d = bend ? `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}` : `M ${sx} ${sy} L ${ex} ${ey}`;
        const lit = e.to === active;
        return (
          <g key={i} className={lit ? "text-text-dark" : "text-text-muted"}>
            <path d={d} fill="none" stroke="currentColor" strokeWidth={lit ? 1.5 : 1} markerEnd="url(#arrow)" />
            {e.label && (
              <text x={mx} y={my - 4} fontSize="9" textAnchor="middle" fill="currentColor" className="font-mono">
                {e.label}
              </text>
            )}
          </g>
        );
      })}
      {nodes.map((n) => {
        const lit = n.id === active;
        return (
          <g key={n.id} className={clsx(lit ? "text-text-dark" : "text-text-light")}>
            <rect
              x={n.x}
              y={n.y}
              width={W}
              height={H}
              rx="6"
              fill={lit ? "var(--color-neutral-800)" : "var(--color-surface-sunken)"}
              stroke={lit ? "var(--color-neutral-800)" : "var(--color-border-subtle)"}
            />
            <text
              x={n.x + W / 2}
              y={n.y + H / 2 + 4}
              fontSize="11"
              textAnchor="middle"
              className="font-mono"
              fill={lit ? "var(--color-white)" : "currentColor"}
            >
              {n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
