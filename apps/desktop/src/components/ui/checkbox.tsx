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
 *
 * 印は Radix の Indicator を使わず、ボタンの data-state を見て CSS で出し分ける
 * （#168）。Indicator は付け外しのたびに getComputedStyle で動きの有無を調べる
 * ので、数千行の一覧ではチェックの数だけスタイルの再計算が走り、画面が固まる。
 */
export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "group/check flex size-4 shrink-0 items-center justify-center rounded border border-line bg-canvas outline-none transition-colors",
        "hover:border-line-strong focus-visible:ring-2 focus-visible:ring-brand/40",
        "data-[state=checked]:border-brand data-[state=checked]:bg-brand",
        "data-[state=checked]:text-brand-ink",
        "data-[state=indeterminate]:border-brand data-[state=indeterminate]:bg-brand",
        "data-[state=indeterminate]:text-brand-ink",
        className,
      )}
      {...props}
    >
      <Check
        aria-hidden
        className="hidden size-3 group-data-[state=checked]/check:block"
        strokeWidth={3}
      />
      <Minus
        aria-hidden
        className="hidden size-3 group-data-[state=indeterminate]/check:block"
        strokeWidth={3}
      />
    </CheckboxPrimitive.Root>
  );
}
