import {
  BookMarked,
  CircleCheck,
  Folder,
  Image as ImageIcon,
  Info,
  ListOrdered,
  Package,
  TriangleAlert,
  X,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import {
  checkStateOf,
  TOC_UNREADABLE,
  type CheckState,
  type PlanRow,
} from "../lib/plan";
import { cn } from "../lib/utils";
import { parentDirectory } from "../path";
import { SHORTCUT_SIZE, type HandoffMode } from "./ProducedList";
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

/** 整理済みの印の説明。何をもって整理済みなのかを行に乗せると出す */
const ORGANIZED_TIP =
  "整理済み: 名前・ページ・置き場所が、この道具が作る形と一致しています";

/**
 * 整理済みでない理由の説明。行に乗せると出る。
 *
 * 印を出さない理由（multiple-books / not-zip / name-mismatch）にも用意する。
 * 一覧に印を増やさないだけで、「なぜまた作られるのか」を知る手立ては要る。
 * 鍵はサイドカーの ``organized_reason`` の値そのもの。
 */
const REASON_TIPS: Record<string, string> = {
  "multiple-books":
    "整理済みではありません: 1 つのアーカイブから複数の本が出ます",
  "not-zip": "整理済みではありません: ZIP 以外の形式です",
  "name-mismatch":
    "整理済みではありません: ファイル名が「[著者] 作品名 第001巻.zip」の形と違います",
  "pages-mismatch":
    "整理済みではありません: ページ名が 001, 002, … の連番と違います",
  "extra-entries": "整理済みではありません: ページ以外のファイルが入っています",
  "folder-mismatch":
    "整理済みではありません: 置いてあるフォルダの名前が「[著者] 作品名」と違います",
};

/**
 * 印に出す短い言い換え。名前は整理済みの形なのに落ちた 3 つだけに出す。
 *
 * 残りの 3 つはまだ整理していない蔵書の普通の姿で、そこにも印を足すと一覧が
 * 印で埋まり、直せば整理済みになるこの 3 つが見分けられなくなる。
 */
const REASON_BADGES: Record<string, string> = {
  "folder-mismatch": "フォルダ名が違います",
  "pages-mismatch": "ページの連番が違います",
  "extra-entries": "余計なファイルがあります",
};

/** 理由の説明。知らない理由が来ても黙らず、記号を添えて出す */
function reasonTip(reason: string): string {
  if (reason === "") return "";
  return REASON_TIPS[reason] ?? `整理済みではありません: ${reason}`;
}

/** 1 段ぶんの字下げ。3 階層でも左端の情報量を潰さない幅 */
const INDENT_PX = 14;

/**
 * 外した行で薄める側に回る子の装飾（#73 段階 4c）。
 *
 * 薄めるのは行（`li`）ではなく中の子。行ごと薄めると、その行が外れている
 * 理由そのものである整理済みの印まで一緒に薄まり、「なぜチェックが外れて
 * いるのか」の答えが一番読みにくい所へ置かれてしまう。チェック・整理済みの
 * 印・近道はこの装飾を持たず、いつでも 100% で読める。
 *
 * 行に乗せている間（ホバー・焦点）は全部 100% に戻す。外した行でも、読みたい
 * ときには読めるようにするため。
 */
const DIMMED =
  "opacity-45 group-hover:opacity-100 group-focus-within:opacity-100";

/**
 * 行に乗せている間だけ見せる操作（削除ボタンと近道）の見え方。
 *
 * 席は常に空けておき、見え方だけを切り替える。乗せてから初めて置くと行の
 * 中身が押し出され、狙って押せなくなる。Tab で辿り着いたときにも見えないと
 * 押しどころが分からないので、焦点でも出す。
 */
const REVEAL_ON_ROW =
  "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100";

type PlanListProps = {
  rows: PlanRow[];
  /** 外した葉の鍵。行そのものは消さず、薄く残す */
  excluded: ReadonlySet<string>;
  /** 行に出す名前。作品名と著者から組み立て直したもの */
  names: Map<string, string>;
  /** 出力先。入れ直した整理済みの行が指す行き先の頭になる */
  outputDirectory: string;
  /** 実行中は選び直せない。再実行で `_1` が二重に付くのを防ぐ */
  locked: boolean;
  onToggle: (row: PlanRow, keep: boolean) => void;
  /** 放り込んだもの（level 0）を一覧から落とす */
  onRemove: (path: string) => void;
  /** 整理済みの本を、そのまま次の画面へ読み込ませる */
  onOpenArchive: (path: string, mode: HandoffMode) => void;
};

/** 行の見出しに置く絵。何を指している行なのかを字を読まずに掴めるようにする */
function RowIcon({ kind, dim }: { kind: PlanRow["kind"]; dim?: string }) {
  const shared = cn("size-3.5 shrink-0", dim);
  if (kind === "folder")
    return <Folder data-dim className={cn(shared, "text-brand/80")} />;
  if (kind === "archive")
    return <Package data-dim className={cn(shared, "text-ink-faint")} />;
  return <BookMarked data-dim className={cn(shared, "text-ink-faint")} />;
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
  outputDirectory,
  locked,
  onToggle,
  onRemove,
  onOpenArchive,
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
          outputDirectory={outputDirectory}
          locked={locked}
          onToggle={onToggle}
          onRemove={onRemove}
          onOpenArchive={onOpenArchive}
        />
      ))}
    </ul>
  );
}

type PlanListRowProps = {
  row: PlanRow;
  state: CheckState;
  name: string;
  outputDirectory: string;
  locked: boolean;
  onToggle: (row: PlanRow, keep: boolean) => void;
  onRemove: (path: string) => void;
  onOpenArchive: (path: string, mode: HandoffMode) => void;
};

function PlanListRow({
  row,
  state,
  name,
  outputDirectory,
  locked,
  onToggle,
  onRemove,
  onOpenArchive,
}: PlanListRowProps) {
  const removable = row.level === 0;
  const off = state === false;
  const dim = off ? DIMMED : undefined;
  // 整理済みの本は、既にディスク上に最終形で在る。整理を待たずにそのまま
  // 開けるので、行から次の作業へ渡せる（作る・作らないとは関わりが無い）
  const finished = row.kind === "book" && row.organized;
  const showsDestination = finished && state === true;

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
      data-organized={String(row.organized)}
      data-organized-reason={row.organizedReason}
      // 印を出さない理由でも、行に乗せれば何が違うのかを読める。
      // 整理済みの行には説明を付けない（印そのものが説明を持っている）
      title={reasonTip(row.organizedReason) || undefined}
      tabIndex={0}
      style={{ paddingLeft: 8 + row.level * INDENT_PX }}
      className={cn(
        // 行の高さは中で一番背の高いもの（削除ボタン 24px）で決まる。
        // 余白を 2px に絞り、1 行 28px に収める
        "group flex items-center gap-2 rounded-control pr-2 py-0.5 outline-none",
        "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2",
        "focus-visible:ring-brand/40",
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
      <RowIcon kind={row.kind} dim={dim} />
      {/* 名前と場所は一組の情報。名前の幅は中身で決め、余った幅は場所へ渡す */}
      <span
        data-testid="plan-row-name"
        data-dim
        className={cn("min-w-0 truncate text-[12.5px] font-medium", dim)}
      >
        {row.kind === "book" ? name : basename(row.path)}
      </span>
      <span
        data-testid="plan-row-path"
        data-dim
        className={cn(
          "min-w-0 flex-1 truncate text-[11px]",
          // 行き先は元の場所より 1 段濃くする。これから起きることなので、
          // 済んだ場所より先に読ませたい
          showsDestination ? "text-ink-muted" : "text-ink-faint",
          dim,
        )}
        title={row.kind === "book" ? row.entry : row.path}
      >
        {where(row, showsDestination, outputDirectory)}
      </span>
      <RowBadges row={row} dim={dim} />
      {/*
        近道は印の右に置く。左へ割り込ませると整理済みの印が行の中ほどまで
        押し戻され、その行にすることが無いと一目で読めなくなる。
      */}
      {finished ? (
        <RowShortcuts
          name={name}
          // 渡すのは今ディスク上に在るファイル。これから作られる行き先では
          // まだ開けない
          source={row.source}
          onOpen={onOpenArchive}
        />
      ) : null}
      {removable ? (
        <Button
          variant="ghost"
          size="icon"
          title="一覧から外す"
          aria-label="一覧から外す"
          data-testid="plan-remove"
          disabled={locked}
          className={REVEAL_ON_ROW}
          onClick={() => onRemove(row.path)}
        >
          <X />
        </Button>
      ) : null}
    </li>
  );
}

/**
 * 行の右側に出す印。整理済み → 直せば整理済みになる理由 → 警告 の順。
 *
 * 状態（整理済み）を先に置くのは、その行にすることが無いと分かればそれ以上
 * 読まなくて済むため。今までこの席は警告だけの席で「何かが壊れている」を
 * 意味していたので、緑と CircleCheck で「終わっている」と読み分けさせる。
 */
function RowBadges({ row, dim }: { row: PlanRow; dim?: string }) {
  const reasonBadge = REASON_BADGES[row.organizedReason];
  return (
    <>
      {/*
        整理済みの印だけは薄めない。この印はその行のチェックが外れている理由
        そのもので、一緒に薄めると「なぜ作られないのか」の答えが一番読みにくい
        所に置かれることになる。
      */}
      {row.organized ? (
        <Badge tone="ok" data-testid="plan-row-state" title={ORGANIZED_TIP}>
          <CircleCheck className="size-3" />
          整理済み
        </Badge>
      ) : null}
      {reasonBadge ? (
        <Badge
          tone="neutral"
          data-testid="plan-row-reason"
          data-reason={row.organizedReason}
          data-dim
          className={dim}
          title={reasonTip(row.organizedReason)}
        >
          <Info className="size-3" />
          {reasonBadge}
        </Badge>
      ) : null}
      {row.issues.map((issue) => (
        <Badge
          key={issue}
          tone="warn"
          data-testid="plan-row-issue"
          data-dim
          className={dim}
        >
          <TriangleAlert className="size-3" />
          {issueLabel(issue)}
        </Badge>
      ))}
    </>
  );
}

/**
 * 整理済みの行に置く、次の作業への近道。
 *
 * 出来たファイルの一覧（`ProducedList`）と同じ顔・同じ受け渡しにする。同じ
 * ことをする近道が画面ごとに違う顔をしていると、押す前に読み直すことになる。
 * 各画面は今までどおり単独で使えるのが主で、これは任意の近道でしかない。
 */
function RowShortcuts({
  name,
  source,
  onOpen,
}: {
  name: string;
  source: string;
  onOpen: (path: string, mode: HandoffMode) => void;
}) {
  return (
    <>
      <Button
        variant="ghost"
        className={cn(SHORTCUT_SIZE, REVEAL_ON_ROW)}
        data-testid="plan-to-thumbnail"
        title={`${name} のサムネイルを作る`}
        onClick={() => onOpen(source, "thumbnail")}
      >
        <ImageIcon />
        サムネイル
      </Button>
      <Button
        variant="ghost"
        className={cn(SHORTCUT_SIZE, REVEAL_ON_ROW)}
        data-testid="plan-to-reorder"
        title={`${name} のページを並べ替える`}
        onClick={() => onOpen(source, "reorder")}
      >
        <ListOrdered />
        ページ
      </Button>
    </>
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

/**
 * 名前の隣に出す場所。行き先を指すときだけ、元ではなく出力先を出す。
 *
 * 行き先に変えるのは、整理済みの本を入れ直したときだけ（#73 段階 4c）。
 * 整理済みの本は元の場所も出来上がる形も同じなので、元を指したままだと
 * 入れ直したことが行から読めない。逆にまだディスク上に無い本で行き先を
 * 出すと、既に在るかのように読めてしまう。
 */
function where(
  row: PlanRow,
  showsDestination: boolean,
  outputDirectory: string,
): string {
  if (row.kind !== "book") return parentDirectory(row.path);
  if (!showsDestination) return origin(row);
  // 作品フォルダは本自身の名前で決まる（#73 段階 4a）。左の列の対で組み立てると
  // 整理済みの本が実際に作られる場所と違うフォルダを指してしまう
  return `→ ${outputDirectory}/[${row.author}] ${row.title}/`;
}
