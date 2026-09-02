import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-card border border-line bg-surface shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-line bg-surface-2/60 px-3 py-2",
        className,
      )}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-3", className)} {...props} />;
}
