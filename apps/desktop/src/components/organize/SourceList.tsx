import { Folder, Loader2, Package, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { Analysis } from "../../lib/analysis";
import { sourceCount } from "../../lib/organize-text";
import type { PlanRow } from "../../lib/plan";
import { cn } from "../../lib/utils";
import { parentDirectory } from "../../path";
import { Button } from "../ui/button";

type SourceListProps = {
  /** 投入したもの。App が持つ一覧そのもの */
  sources: string[];
  /** 右の一覧と同じ行。冊数もアイコンもここから導く */
  rows: PlanRow[];
  analysis: Pick<Analysis, "running" | "settled">;
  /** 実行中は中身を変えさせない。実際に処理される内容と画面が食い違う */
  disabled: boolean;
  onRemove: (path: string) => void;
};

/**
 * 左の列の「投入したもの」の一覧。
 *
 * 何を入れたかを見せ、入れたものごと外す唯一の場所。外す操作は右の
 * 「出来上がる本」には置かない。両方に置くと同じものが 2 か所で消せる
 * ことになり、投入と結果が混ざって見えていた元の問題が形を変えて戻る。
 * 右で作らないのはチェック、入れたものごと外すのはここの ×。
 */
export function SourceList({
  sources,
  rows,
  analysis,
  disabled,
  onRemove,
}: SourceListProps) {
  return (
    // 溢れた行はこの箱の中でスクロールする。左の列そのものは動かさない
    <ul
      className="min-h-0 flex-1 divide-y divide-line/60 overflow-y-auto p-1"
      data-testid="source-list"
    >
      {sources.map((path) => (
        <SourceRow
          key={path}
          path={path}
          // フォルダかどうかは右の一番外側の行と同じ根拠で決める。別々に
          // 決めると、.zip という名前のフォルダで左右の絵が食い違う
          folder={rows.some((row) => row.id === path && row.kind === "folder")}
          count={sourceCount(rows, path, analysis)}
          disabled={disabled}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

/**
 * 投入 1 件の行。1 行目が名前、2 行目が場所とそこから出来る数の 2 行組。
 *
 * 右の一覧（28px の 1 行）と高さを変えるのは、左右の一覧が同じ物の並びに
 * 見えないようにするため。左は「何を入れたか」、右は「何が出来るか」。
 */
function SourceRow({
  path,
  folder,
  count,
  disabled,
  onRemove,
}: {
  path: string;
  folder: boolean;
  count: ReturnType<typeof sourceCount>;
  disabled: boolean;
  onRemove: (path: string) => void;
}) {
  const name = path.split(/[/\\]/).pop() ?? path;

  /** Delete でも外せる。× と同じく実行中は効かない */
  const handleKey = (event: KeyboardEvent) => {
    if (disabled) return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    onRemove(path);
  };

  return (
    <li
      data-testid="source-row"
      data-path={path}
      data-kind={folder ? "folder" : "archive"}
      tabIndex={0}
      className={cn(
        "group flex h-10 shrink-0 flex-col justify-center gap-px rounded-control pr-1 pl-2 outline-none",
        "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2",
        "focus-visible:ring-brand/40",
      )}
      onKeyDown={handleKey}
    >
      <div className="flex h-[22px] items-center gap-2">
        {folder ? (
          <Folder className="size-3.5 shrink-0 text-brand/80" />
        ) : (
          <Package className="size-3.5 shrink-0 text-ink-faint" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          {name}
        </span>
        {/* 乗せなくても見える（薄く）。乗せてから初めて見える作りだと、
            外せること自体に気づけない */}
        <Button
          variant="ghost"
          size="icon"
          title="入れたものごと外す"
          aria-label={`${name} を外す`}
          data-testid="source-remove"
          disabled={disabled}
          className="opacity-55 group-focus-within:opacity-100 group-hover:opacity-100"
          onClick={() => onRemove(path)}
        >
          <X />
        </Button>
      </div>
      {/* 2 行目は名前の下へ字下げし、場所を左に、数を右に置く */}
      <div className="flex h-4 items-center gap-2 pl-[22px] text-[11px]">
        <span className="min-w-0 flex-1 truncate text-ink-faint" title={path}>
          {parentDirectory(path)}
        </span>
        {count ? (
          <span
            data-testid="source-count"
            data-tone={count.tone}
            title={count.title}
            className={cn(
              "tabular flex shrink-0 items-center gap-1 whitespace-nowrap",
              count.tone === "warn"
                ? "text-warn"
                : count.tone === "busy"
                  ? "text-brand"
                  : "text-ink-muted",
            )}
          >
            {count.tone === "busy" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : null}
            {count.text}
          </span>
        ) : null}
      </div>
    </li>
  );
}
