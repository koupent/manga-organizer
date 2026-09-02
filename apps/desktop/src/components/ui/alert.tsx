import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const alertVariants = cva(
  "flex items-start gap-2 rounded-md border px-3 py-2 text-[12.5px] [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:mt-0.5",
  {
    variants: {
      tone: {
        warn: "border-warn/30 bg-warn/10 text-warn",
        danger: "border-danger/30 bg-danger/10 text-danger",
        info: "border-line bg-surface text-ink-muted",
      },
    },
    defaultVariants: { tone: "info" },
  },
);

export function Alert({
  className,
  tone,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div className={cn(alertVariants({ tone }), className)} {...props} />;
}
