import { cn } from "../../lib/utils";

/** モードの切り替え。現在地と押せる範囲を一目で分かるようにする */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
}: {
  items: { id: T; label: string; testId?: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div
      role="group"
      className="inline-flex items-center gap-0.5 rounded-card border border-line bg-canvas p-0.5"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
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
      ))}
    </div>
  );
}
