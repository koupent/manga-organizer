import { Package, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { cn } from "../../lib/utils";
import { parentDirectory } from "../../path";
import { Button } from "../ui/button";

type SourceListProps = {
  /** 投入したもの。App が持つ一覧そのもの */
  sources: string[];
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
export function SourceList({ sources, disabled, onRemove }: SourceListProps) {
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
          disabled={disabled}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

function SourceRow({
  path,
  disabled,
  onRemove,
}: {
  path: string;
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
      tabIndex={0}
      className={cn(
        "group flex min-h-7 items-center gap-2 rounded-control py-0.5 pr-1 pl-2 outline-none",
        "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2",
        "focus-visible:ring-brand/40",
      )}
      onKeyDown={handleKey}
    >
      <Package className="size-3.5 shrink-0 text-ink-faint" />
      {/* 名前と場所は一組の情報。名前の幅は中身で決め、余った幅は場所へ渡す */}
      <span className="min-w-0 truncate text-[12.5px] font-medium">{name}</span>
      <span
        className="min-w-0 flex-1 truncate text-[11px] text-ink-faint"
        title={path}
      >
        {parentDirectory(path)}
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
    </li>
  );
}
