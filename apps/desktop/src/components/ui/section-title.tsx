import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * 区画の見出し。
 *
 * 見出しは中身より先に読まれるものであって、中身より目立つ必要はない。
 * 帯や枠で囲うと箱代を払ううえ、区画そのものが重く見えるので、
 * 文字の大きさと色だけで一段下げる。
 */
export function SectionTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn("text-[11.5px] font-medium text-ink-muted", className)}
      {...props}
    />
  );
}
