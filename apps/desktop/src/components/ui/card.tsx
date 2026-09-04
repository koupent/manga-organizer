import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/**
 * 面。
 *
 * 区切りは枠線 1 本だけにする。枠線と影を重ねると、同じ 1 枚の面が
 * 二重に縁取られて実際より大きく見える。影はダイアログのように
 * 手前へ浮かせたいものだけに残す。
 */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-card border border-line bg-surface", className)}
      {...props}
    />
  );
}

/**
 * 面の上端に置く操作の行。
 *
 * 一覧を持つ面（ファイルブラウザなど）で、操作と一覧を分けるためだけに使う。
 * 背景色を敷くと帯になり、面の中にもう 1 枚の面があるように見えるので、
 * 区切りは 1px の横線 1 本に留める。ただの見出しにはこれを使わない。
 */
export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-line px-2 py-1.5",
        className,
      )}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-2", className)} {...props} />;
}
