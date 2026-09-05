import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * チェックボックス。三態（全部 / 一部 / 無し）まで扱う。
 *
 * 一部だけ入っている状態は checked に "indeterminate" を渡す。読み上げには
 * Radix が aria-checked="mixed" を出す。印を横棒にするのは、レ点のままだと
 * 「全部入っている」と見分けが付かないため。
 */
export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>) {
  const mixed = props.checked === "indeterminate";
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "size-4 shrink-0 rounded border border-line bg-canvas outline-none transition-colors",
        "hover:border-line-strong focus-visible:ring-2 focus-visible:ring-brand/40",
        "data-[state=checked]:border-brand data-[state=checked]:bg-brand",
        "data-[state=checked]:text-brand-ink",
        "data-[state=indeterminate]:border-brand data-[state=indeterminate]:bg-brand",
        "data-[state=indeterminate]:text-brand-ink",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {mixed ? (
          <Minus className="size-3" strokeWidth={3} />
        ) : (
          <Check className="size-3" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
