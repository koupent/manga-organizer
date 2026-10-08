import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

type PageCardProps = Omit<HTMLAttributes<HTMLDivElement>, "part"> & {
  mode: "split" | "merge" | "margin";
  index: number;
  part?: 0 | 1;
  label: string;
  pending: boolean;
  focused: boolean;
  span: boolean;
  boxHeight: number;
  onZoom?: () => void;
  status?: ReactNode;
  actions: ReactNode;
};

/** 各モードで番号を左下、操作を右下に固定するページカード。 */
export function PageCard({
  mode,
  index,
  part,
  label,
  pending,
  focused,
  span,
  boxHeight,
  onZoom,
  status,
  actions,
  className,
  children,
  ...props
}: PageCardProps) {
  return (
    <div
      tabIndex={-1}
      className={cn(
        "group flex flex-col overflow-hidden rounded-card border border-line outline-none",
        "bg-surface transition-[border-color,opacity] hover:border-line-strong",
        span && "col-span-2",
        focused && "border-brand ring-2 ring-brand/40",
        className,
      )}
      data-testid={`${mode}-card`}
      data-index={index}
      data-part={part}
      data-focused={focused}
      {...props}
    >
      {/* キーボードでの拡大は EditablePage のヘッダーボタンから行う。 */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className={cn(
          "relative flex flex-none items-center justify-center bg-canvas",
          onZoom && "cursor-zoom-in",
        )}
        style={{ height: boxHeight }}
        onClick={onZoom}
      >
        {children}
      </div>
      <div
        data-testid="page-card-footer"
        className="flex h-9 shrink-0 items-center gap-1.5 border-t border-line px-2"
      >
        <span
          data-testid={`${mode}-number`}
          data-pending={pending}
          className={cn(
            "tabular min-w-6 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold",
            pending ? "bg-brand text-brand-ink" : "bg-surface-2 text-ink-muted",
          )}
        >
          {label}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {status}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      </div>
    </div>
  );
}
