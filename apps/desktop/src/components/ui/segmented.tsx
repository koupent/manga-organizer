import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** モードの切り替え。現在地と押せる範囲を一目で分かるようにする */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  disabled = false,
}: {
  items: { id: T; label: ReactNode; testId?: string; description?: string }[];
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      className="inline-flex items-center gap-0.5 rounded-card border border-line bg-canvas p-0.5"
    >
      {items.map((item) => (
        <Tooltip.Provider key={item.id} delayDuration={800}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                key={item.id}
                type="button"
                disabled={disabled}
                data-testid={item.testId}
                aria-pressed={value === item.id}
                onClick={() => onChange(item.id)}
                className={cn(
                  // 外枠（p-0.5 + border）を合わせて 30px。ヘッダー 40px に収める
                  "h-6 rounded-control px-2.5 text-[12.5px] font-medium transition-colors",
                  value === item.id
                    ? "bg-brand text-brand-ink"
                    : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                )}
              >
                {item.label}
              </button>
            </Tooltip.Trigger>
            {item.description ? (
              <Tooltip.Portal>
                <Tooltip.Content
                  side="bottom"
                  sideOffset={6}
                  className="z-50 max-w-xs rounded border border-line bg-surface p-2 text-xs text-ink shadow-xl"
                >
                  {item.description}
                </Tooltip.Content>
              </Tooltip.Portal>
            ) : null}
          </Tooltip.Root>
        </Tooltip.Provider>
      ))}
    </div>
  );
}
