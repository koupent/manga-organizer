import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-7 w-full rounded-control border border-line bg-canvas px-2.5 text-[12.5px]",
        "text-ink placeholder:text-ink-faint outline-none transition-colors",
        "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/25",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
