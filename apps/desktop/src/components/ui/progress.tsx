import * as ProgressPrimitive from "@radix-ui/react-progress";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * 進捗バー。
 *
 * 見た目だけの div にすると支援技術には何も伝わらないため、
 * role と aria-value* を自前で書かずに済む Radix の実装に乗せる。
 * 読み上げが「50%」のように揃うよう、値は 0-100 の整数で渡す。
 */
export function Progress({
  className,
  value,
  ...props
}: ComponentProps<typeof ProgressPrimitive.Root>) {
  const filled = Math.round(value ?? 0);

  return (
    <ProgressPrimitive.Root
      value={filled}
      className={cn("h-1 overflow-hidden rounded-full bg-canvas", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="h-full bg-brand transition-[width] duration-200"
        style={{ width: `${filled}%` }}
      />
    </ProgressPrimitive.Root>
  );
}
