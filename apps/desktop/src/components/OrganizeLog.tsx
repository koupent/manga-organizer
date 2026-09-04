import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { SectionTitle } from "./ui/section-title";

/**
 * 開いているときの本文の高さ。
 *
 * 中身の量で伸び縮みさせない。ログが増えるたびに処理対象の一覧が
 * 押し縮められ、行を見ている最中に表示がずれることになるため。
 */
const LOG_HEIGHT = "h-[120px]";

/**
 * 処理ログのドック。
 *
 * 実行の経過は「見たいときだけ見る」もので、常に画面の高さを取り続ける
 * ものではない。処理対象の一覧の下に固定し、畳めるようにする。
 *
 * 畳んでも中身は DOM に残す。ログは実行の証跡であり、畳んだ瞬間に
 * 消えてしまうと、後から開いても何も無いのと区別が付かない。
 */
export function OrganizeLog({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(true);

  return (
    <section className="flex shrink-0 flex-col gap-1">
      <button
        type="button"
        className="flex w-fit items-center gap-1 text-ink-muted hover:text-ink"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown
          className={cn("size-3 transition-transform", !open && "-rotate-90")}
        />
        <SectionTitle>処理ログ</SectionTitle>
      </button>
      <pre
        hidden={!open}
        className={cn(
          "overflow-auto rounded-card border border-line bg-surface p-2",
          "font-mono text-[11.5px] leading-relaxed text-ink-muted",
          LOG_HEIGHT,
        )}
        data-testid="organize-log"
      >
        {lines.length > 0 ? lines.join("\n") : "まだ実行していません"}
      </pre>
    </section>
  );
}
