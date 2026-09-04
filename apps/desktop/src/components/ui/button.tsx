import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** 用途で見た目を変える。主要な操作は 1 画面に 1 つに絞る */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control " +
    "font-medium transition-colors outline-none " +
    "focus-visible:ring-2 focus-visible:ring-brand/60 " +
    "disabled:pointer-events-none disabled:opacity-40 " +
    "[&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-brand text-brand-ink hover:bg-brand/90",
        secondary:
          "bg-surface-2 text-ink border border-line hover:border-line-strong",
        ghost: "text-ink-muted hover:bg-surface-2 hover:text-ink",
        danger:
          "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
      },
      // 寸法は 3 つだけ。既定を 28px まで下げ、32px は主操作へ譲る。
      // 同じ高さの操作が並ぶと、どれが主操作か高さからは読み取れなくなるため、
      // lg は 1 画面に 1 つだけ使う。
      size: {
        md: "h-7 px-2.5 text-[12px]",
        lg: "h-8 px-3 text-[12.5px]",
        icon: "size-6",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
