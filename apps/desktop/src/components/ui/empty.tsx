import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** 何も無いときに、次にすることを示す */
export function Empty({
  icon,
  title,
  children,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="text-ink-faint [&_svg]:size-7">{icon}</div>
      ) : null}
      <p className="text-[13px] font-medium text-ink-muted">{title}</p>
      {children ? (
        <p className="max-w-[46ch] text-[12px] text-ink-faint">{children}</p>
      ) : null}
    </div>
  );
}
