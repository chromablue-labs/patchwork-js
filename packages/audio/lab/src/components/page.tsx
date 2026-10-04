import clsx from "clsx";
import type { ReactNode } from "react";

/** Same shell as web/src/components/page/page-header.tsx and page-body.tsx. */
export function PageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="sticky top-0 z-20 h-14 border-b border-border-subtle px-6 bg-surface-raised">
      <div className="flex items-center justify-between h-full">
        <h1 className="text-base font-medium text-text-dark">{title}</h1>
        <div className="flex gap-2 items-center">{actions}</div>
      </div>
    </div>
  );
}

export function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("flex w-full flex-col gap-6 px-6 py-6 max-w-[1240px]", className)}>{children}</div>;
}
