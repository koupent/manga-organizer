import { BookMarked, Folder, Package, TriangleAlert, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import {
  checkStateOf,
  TOC_UNREADABLE,
  type CheckState,
  type PlanRow,
} from "../lib/plan";
import { cn } from "../lib/utils";
import { parentDirectory } from "../path";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

/** 巻数が名前から読めなかった */
export const VOLUME_UNKNOWN = "volume-unknown";

/** 巻数を読んだ根拠が弱く、誤読しうる */
export const VOLUME_UNCERTAIN = "volume-uncertain";

/** 印の言い換え。知らない印が来ても、印そのものは消さずに素で出す */
const ISSUE_LABELS: Record<string, string> = {
  [VOLUME_UNKNOWN]: "巻数が読めません",
  [VOLUME_UNCERTAIN]: "巻数が怪しい",
  [TOC_UNREADABLE]: "目次を読めません",
};

/** 印の説明。主操作の行のチップと一覧の行で同じ言葉を使う */
export function issueLabel(issue: string): string {
  return ISSUE_LABELS[issue] ?? issue;
}

/** 1 段ぶんの字下げ。3 階層でも左端の情報量を潰さない幅 */
const INDENT_PX = 14;

type PlanListProps = {
  rows: PlanRow[];
  /** 外した葉の鍵。行そのものは消さず、薄く残す */
  excluded: ReadonlySet<string>;
  /** 行に出す名前。作品名と著者から組み立て直したもの */
  names: Map<string, string>;
  /** 実行中は選び直せない。再実行で `_1` が二重に付くのを防ぐ */
  locked: boolean;
  onToggle: (row: PlanRow, keep: boolean) => void;
  /** 放り込んだもの（level 0）を一覧から落とす */
  onRemove: (path: string) => void;
};

/** 行の見出しに置く絵。何を指している行なのかを字を読まずに掴めるようにする */
function RowIcon({ kind }: { kind: PlanRow["kind"] }) {
  if (kind === "folder")
    return <Folder className="size-3.5 shrink-0 text-brand/80" />;
  if (kind === "archive")
    return <Package className="size-3.5 shrink-0 text-ink-faint" />;
  return <BookMarked className="size-3.5 shrink-0 text-ink-faint" />;
}

/**
 * 解析した結果を 3 階層で見せる一覧。
 *
 * 行は消さない。外したものが消えると、何を外したのかが後から分からなくなる。
 * 薄くして残し、チェックの状態だけで「作る / 作らない」を示す。
 */
export function PlanList({
  rows,
  excluded,
  names,
  locked,
  onToggle,
  onRemove,
}: PlanListProps) {
  return (
    <ul
      className="min-h-0 flex-1 divide-y divide-line/60 overflow-y-auto p-1"
      data-testid="plan-list"
    >
      {rows.map((row) => (
        <PlanListRow
          key={row.id}
          row={row}
          state={checkStateOf(row, excluded)}
          name={names.get(row.id) ?? ""}
          locked={locked}
          onToggle={onToggle}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

type PlanListRowProps = {
  row: PlanRow;
  state: CheckState;
  name: string;
  locked: boolean;
  onToggle: (row: PlanRow, keep: boolean) => void;
  onRemove: (path: string) => void;
};

function PlanListRow({
  row,
  state,
  name,
  locked,
  onToggle,
  onRemove,
}: PlanListRowProps) {
  const removable = row.level === 0;
  const off = state === false;

  /** Delete で、放り込んだものを一覧から落とす */
  const handleKey = (event: KeyboardEvent) => {
    if (locked || !removable) return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    onRemove(row.path);
  };

  return (
    <li
      data-testid="plan-row"
      data-kind={row.kind}
      data-level={row.level}
      data-path={row.path}
      data-source={row.source}
      data-entry={row.entry}
      data-output-name={row.kind === "book" ? name : ""}
      data-issues={row.issues.join(" ")}
      tabIndex={0}
      style={{ paddingLeft: 8 + row.level * INDENT_PX }}
      className={cn(
        // 行の高さは中で一番背の高いもの（削除ボタン 24px）で決まる。
        // 余白を 2px に絞り、1 行 28px に収める
        "group flex items-center gap-2 rounded-control pr-2 py-0.5 outline-none",
        "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2",
        "focus-visible:ring-brand/40",
        // 外した行は消さずに薄く残す
        off && "opacity-45",
      )}
      onKeyDown={handleKey}
    >
      <Checkbox
        data-testid="plan-check"
        checked={state}
        disabled={locked}
        aria-label={row.kind === "book" ? name : row.path}
        onCheckedChange={() => onToggle(row, state !== true)}
      />
      <RowIcon kind={row.kind} />
      {/* 名前と場所は一組の情報。名前の幅は中身で決め、余った幅は場所へ渡す */}
      <span className="min-w-0 truncate text-[12.5px] font-medium">
        {row.kind === "book" ? name : basename(row.path)}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[11px] text-ink-faint"
        title={row.kind === "book" ? row.entry : row.path}
      >
        {row.kind === "book" ? origin(row) : parentDirectory(row.path)}
      </span>
      {row.issues.map((issue) => (
        <Badge key={issue} tone="warn" data-testid="plan-row-issue">
          <TriangleAlert className="size-3" />
          {issueLabel(issue)}
        </Badge>
      ))}
      {removable ? (
        <Button
          variant="ghost"
          size="icon"
          title="一覧から外す"
          aria-label="一覧から外す"
          data-testid="plan-remove"
          disabled={locked}
          // Tab で辿り着いたときに見えないと押しどころが分からない
          className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          onClick={() => onRemove(row.path)}
        >
          <X />
        </Button>
      ) : null}
    </li>
  );
}

/** パスの末尾。場所は隣の欄が受け持つ */
function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** 本がどこから出来るか。アーカイブ全体が 1 冊なら位置は無い */
function origin(row: PlanRow): string {
  return row.entry ? `← ${row.entry}` : "← アーカイブ全体";
}
