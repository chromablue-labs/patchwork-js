import clsx from "clsx";
import type { ReactNode } from "react";

/** Same as web/src/components/page/card.tsx. */
export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={clsx("card border bg-surface", className ?? "p-5")}>
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-0.5 min-w-65 flex-1">
        <h2 className="text-[15px] font-medium text-text-dark">{title}</h2>
        {description && (
          <p className="text-2xs text-text-light leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A labelled number, monospace. The lab's unit of "showing". */
export function Readout({
  label,
  value,
  unit,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: string;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-col gap-0.5 min-w-0", className)}>
      <span className="text-2xs text-text-light truncate">{label}</span>
      <span className="readout-value truncate">
        {value}
        {unit && <span className="text-2xs text-text-muted ml-1">{unit}</span>}
      </span>
    </div>
  );
}

export function ReadoutRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("grid gap-4 grid-cols-2 sm:grid-cols-4", className)}>
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center py-10 text-[13px] text-text-light text-center">
      {children}
    </div>
  );
}
