import { FileNameEditor } from "./FileNameEditor";
import {
  ArrowRight,
  BookMarked,
  CircleCheck,
  Folder,
  Package,
  Trash2,
  Undo2,
  TriangleAlert,
} from "lucide-react";
import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type CSSProperties,
} from "react";
import type { FinishedBook } from "../lib/analysis";
import {
  byName,
  checkStateOf,
  TOC_UNREADABLE,
  VOLUME_DUPLICATE,
  VOLUME_UNCERTAIN,
  VOLUME_UNKNOWN,
  type CheckState,
  type PlanRow,
} from "../lib/plan";
import { cn } from "../lib/utils";
import { readDigits } from "../lib/volumes";
import { parentDirectory } from "../path";
import {
  EditShortcuts,
  type EditMarks,
  type HandoffMode,
} from "./EditShortcuts";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

/** 印の言い換え。知らない印が来ても、印そのものは消さずに素で出す */
const ISSUE_LABELS: Record<string, string> = {
  [VOLUME_UNKNOWN]: "巻数が読めません",
  [VOLUME_UNCERTAIN]: "巻数が怪しい",
  [VOLUME_DUPLICATE]: "巻数が重なる",
  [TOC_UNREADABLE]: "目次を読めません",
};

/** 印の説明。主操作の行のチップと一覧の行で同じ言葉を使う */
export function issueLabel(issue: string): string {
  return ISSUE_LABELS[issue] ?? issue;
}

/** 整理済みの印の説明。何をもって整理済みなのかを行に乗せると出す */
/**
 * 同じ巻が重なって ``_1`` などの番号が付いた名前（#178）。整理が作る名前
 * （``… 第003巻_1.zip`` / ``… Unknown_1.zip``）だけを見る
 */
const NUMBERED = /(?:巻|Unknown)_\d+\.zip$/;

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
};

/**
 * 印に出す短い言い換え。名前は整理済みの形なのに中身で落ちた 2 つだけに出す。
 *
 * 残りの 3 つはまだ整理していない蔵書の普通の姿で、そこにも印を足すと一覧が
 * 印で埋まり、直せば整理済みになるこの 2 つが見分けられなくなる。
 */
const REASON_BADGES: Record<string, string> = {
  "pages-mismatch": "ページの連番が違います",
  "extra-entries": "余計なファイルがあります",
};

/**
 * 理由の説明。知らない理由が来ても黙らず、記号を添えて出す。
 *
 * 中身（どのページが何と違うか）があれば 2 行目に添える。種類だけでは
 * 「連番が違う」と言われても、利用者には違いを見つけようがない（#126）。
 */
function reasonTip(row: PlanRow): string {
  const reason = row.organizedReason;
  if (reason === "") return "";
  const tip = REASON_TIPS[reason] ?? `整理済みではありません: ${reason}`;
  return row.organizedDetail ? `${tip}\n${row.organizedDetail}` : tip;
}

/** 見出しと行で共有する列幅。 */
const COLUMNS = [
  { key: "source", label: "元のパス", width: 240, min: 120 },
  { key: "name", label: "変換後のファイル名", width: 260, min: 150 },
  { key: "count", label: "画像枚数", width: 64, min: 64 },
  { key: "status", label: "状態", width: 80, min: 76 },
  { key: "actions", label: "操作", width: 96, min: 96 },
] as const;
const GRID =
  "40px var(--plan-source) 12px var(--plan-name) var(--plan-count) var(--plan-status) var(--plan-actions)";

/**
 * 外した行で薄める側に回る子の装飾（#73 段階 4c）。
 *
 * 薄めるのは行（`li`）ではなく中の子。行ごと薄めると、その行が外れている
 * 理由そのものである整理済みの印まで一緒に薄まり、「なぜチェックが外れて
 * いるのか」の答えが一番読みにくい所へ置かれてしまう。チェック・整理済みの
 * 印・近道はこの装飾を持たず、いつでも 100% で読める。
 *
 * 行に乗せている間（ホバー・キーボードの焦点）は全部 100% に戻す。外した行でも、
 * 読みたいときには読めるようにするため。焦点はキーボードで移したとき
 * （``focus-visible``）だけを見る。マウスでチェックを押すとそこに焦点が残るので、
 * 外したばかりの行が明るいまま残り、入っている行と見分けられなくなる（#170）。
 */
const DIMMED =
  "opacity-45 group-hover:opacity-100 group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100";

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
  /** 行のチェックを付け外しする。Shift で押すと、範囲の行がまとめて来る */
  onToggle: (rows: PlanRow[], keep: boolean) => void;
  /** 整理して出来た本の行の鍵 → 出来た本（#160）。整理の途中から増える */
  made: ReadonlyMap<string, FinishedBook>;
  /** 同じ巻の本が 2 冊以上ある行の鍵 → その冊数（#162） */
  sameVolume: ReadonlyMap<string, number>;
  /** 整理済みの本を、そのまま次の画面へ読み込ませる */
  onOpenArchive: (path: string, mode: HandoffMode) => void;
  /** 本のファイルをごみ箱へ移す（#164）。確かめるのは受け取った側 */
  onTrash: (target: TrashTarget) => void;
  onReset: (path: string) => void;
  /** 本ごとの編集済みの種類。整理済みの行の近道に印を出す（#143） */
  edits: EditMarks;
  /** 利用者が巻数を直した本の鍵 */
  corrected: ReadonlySet<string>;
  renamed: ReadonlySet<string>;
  /** 作る本どうしで名前が重なった本の鍵 */
  collided: ReadonlySet<string>;
  /** 巻数を直す。null は Unknown */
  onCorrect: (row: PlanRow, volume: number | null) => void;
  /** 直したうえで、同じ入れ物の下の本に続き番号を振る */
  onFill: (row: PlanRow, volume: number) => void;
  onRename: (row: PlanRow, name: string | null) => void;
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
 * 投入元をまたいで、出来上がる名前順に本を並べる一覧。
 *
 * 行は消さない。外したものが消えると、何を外したのかが後から分からなくなる。
 * 薄くして残し、チェックの状態だけで「作る / 作らない」を示す。
 *
 * 入れたものごと外す操作はここに置かない（左の「投入したもの」の ×）。
 * ここで外せると、同じものを外す場所が 2 か所になる。
 */
export function PlanList({
  rows,
  excluded,
  names,
  outputDirectory,
  locked,
  onToggle,
  made,
  sameVolume,
  onOpenArchive,
  onTrash,
  onReset,
  edits,
  corrected,
  renamed,
  collided,
  onCorrect,
  onFill,
  onRename,
}: PlanListProps) {
  const [widths, setWidths] = useState<number[]>(
    COLUMNS.map((column) => column.width),
  );
  const resize = useRef<{ index: number; start: number; width: number } | null>(
    null,
  );
  const columnStyle = Object.fromEntries(
    COLUMNS.map((column, index) => [
      `--plan-${column.key}`,
      `${widths[index]}px`,
    ]),
  ) as CSSProperties;
  const visibleRows = useMemo(() => {
    const displayedName = (row: PlanRow) => {
      const path = made.get(row.id)?.path;
      return path ? basename(path) : (names.get(row.id) ?? "");
    };
    return rows
      .filter(
        (row) =>
          row.kind === "book" ||
          (row.leaves.length === 1 && row.leaves[0] === row.id),
      )
      .sort((a, b) => {
        const first = displayedName(a);
        const second = displayedName(b);
        if (!first || !second)
          return first ? -1 : second ? 1 : a.id.localeCompare(b.id);
        // 同じ巻では出力先の先着を先に出し、番号なし → _1 → _2 と並べる。
        return (
          byName(
            first.replace(/(?:_\d+)?\.zip$/i, ""),
            second.replace(/(?:_\d+)?\.zip$/i, ""),
          ) ||
          Number(b.existing) - Number(a.existing) ||
          byName(first.replace(/\.zip$/i, ""), second.replace(/\.zip$/i, "")) ||
          a.id.localeCompare(b.id)
        );
      });
  }, [rows, names, made]);
  // Shift で押したときの範囲の起点。最後に押した行（#158）。行は解析の途中で
  // 増えるので、位置ではなく鍵で覚える
  const anchor = useRef<string | null>(null);

  // 行へ渡す関数は 1 度だけ作り、呼ばれたときに最新の props を見る（#168）。
  // 描き直しのたびに作り直すと、中身の変わっていない行まで全部描き直すことになり、
  // 本が数千冊あるとチェック 1 つの切り替えでも目に見えて待たされる
  const latest = useRef({
    rows: visibleRows,
    onToggle,
    onOpenArchive,
    onTrash,
    onReset,
    onCorrect,
    onFill,
    onRename,
  });
  useLayoutEffect(() => {
    latest.current = {
      rows: visibleRows,
      onToggle,
      onOpenArchive,
      onTrash,
      onReset,
      onCorrect,
      onFill,
      onRename,
    };
  });
  const handlers = useMemo<RowHandlers>(
    () => ({
      /** 押した行を切り替える。Shift なら起点からその行までを同じ状態にそろえる */
      toggle: (row, keep, range) => {
        const { rows, onToggle } = latest.current;
        const to = rows.indexOf(row);
        const from = range
          ? rows.findIndex((item) => item.id === anchor.current)
          : -1;
        anchor.current = row.id;
        onToggle(
          from < 0
            ? [row]
            : rows.slice(Math.min(from, to), Math.max(from, to) + 1),
          keep,
        );
      },
      openArchive: (path, mode) => latest.current.onOpenArchive(path, mode),
      trash: (target) => latest.current.onTrash(target),
      reset: (path) => latest.current.onReset(path),
      correct: (row, volume) => latest.current.onCorrect(row, volume),
      fill: (row, volume) => latest.current.onFill(row, volume),
      rename: (row, name) => latest.current.onRename(row, name),
    }),
    [],
  );

  return (
    <ul
      className="min-h-0 flex-1 divide-y divide-line/60 overflow-auto p-1"
      style={columnStyle}
      role="table"
      aria-label="出来上がる本"
      data-testid="plan-list"
    >
      <li
        role="row"
        data-testid="plan-table-header"
        className="sticky top-0 z-10 grid min-h-8 w-max min-w-full items-center gap-2 border-b border-line bg-surface px-2 text-[11px] font-medium text-ink-muted"
        style={{ gridTemplateColumns: GRID }}
      >
        <span role="columnheader">選択</span>
        {COLUMNS.map((column, index) => (
          <span
            key={column.key}
            role="columnheader"
            aria-label={column.label}
            className="relative min-w-0 truncate pr-3"
            style={{ gridColumn: index === 0 ? 2 : index + 3 }}
          >
            {column.label}
            <span
              tabIndex={0}
              role="separator"
              aria-orientation="vertical"
              aria-label={`${column.label}の列幅`}
              aria-valuenow={widths[index]}
              aria-valuemin={column.min}
              data-testid={`resize-${column.key}`}
              title="ドラッグ、または左右キーで列幅を変更"
              className="absolute inset-y-0 right-0 w-2 cursor-col-resize border-r border-line-strong hover:bg-brand/30 focus-visible:bg-brand/30"
              onPointerDown={(event) => {
                resize.current = {
                  index,
                  start: event.clientX,
                  width: widths[index]!,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
                event.preventDefault();
              }}
              onPointerMove={(event) => {
                const moving = resize.current;
                if (!moving || moving.index !== index) return;
                setWidths((current) =>
                  current.map((width, at) =>
                    at === index
                      ? Math.max(
                          column.min,
                          moving.width + event.clientX - moving.start,
                        )
                      : width,
                  ),
                );
              }}
              onPointerUp={() => {
                resize.current = null;
              }}
              onPointerCancel={() => {
                resize.current = null;
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                event.preventDefault();
                setWidths((current) =>
                  current.map((width, at) =>
                    at === index
                      ? Math.max(
                          column.min,
                          width + (event.key === "ArrowRight" ? 20 : -20),
                        )
                      : width,
                  ),
                );
              }}
            />
          </span>
        ))}
      </li>
      {visibleRows.map((row) => {
        const madePath = made.get(row.id)?.path;
        return (
          <PlanListRow
            key={row.id}
            row={row}
            madePath={madePath}
            madeSize={made.get(row.id)?.size}
            sameVolume={sameVolume.get(row.id)}
            checkable={row.leaves.some((leaf) => !made.has(leaf))}
            state={checkStateOf(row, excluded, made)}
            // 出来た本は、実際に出来たファイルの名前を出す（#172）
            name={
              madePath !== undefined
                ? basename(madePath)
                : (names.get(row.id) ?? "")
            }
            outputDirectory={outputDirectory}
            locked={locked}
            handlers={handlers}
            edited={edits[madePath ?? row.source] ?? NOT_EDITED}
            corrected={corrected.has(row.id)}
            renamed={renamed.has(row.id)}
            collided={collided.has(row.id)}
          />
        );
      })}
    </ul>
  );
}

type PlanListRowProps = {
  row: PlanRow;
  /** 整理して出来たファイル。まだ出来ていなければ無い */
  madePath?: string;
  /** 出来たファイルの大きさ */
  madeSize?: number | null;
  /** 同じ巻の本の冊数。1 冊だけなら無い */
  sameVolume?: number;
  /** チェックを出すか。下の本が全部出来た入れ物では出さない（#172） */
  checkable: boolean;
  state: CheckState;
  name: string;
  outputDirectory: string;
  locked: boolean;
  handlers: RowHandlers;
  edited: readonly string[];
  corrected: boolean;
  renamed: boolean;
  collided: boolean;
};

/** 行から呼ぶ操作。一覧が 1 度だけ作って全部の行に渡す（#168） */
type RowHandlers = {
  toggle: (row: PlanRow, keep: boolean, range: boolean) => void;
  openArchive: (path: string, mode: HandoffMode) => void;
  trash: (target: TrashTarget) => void;
  reset: (path: string) => void;
  correct: (row: PlanRow, volume: number | null) => void;
  fill: (row: PlanRow, volume: number) => void;
  rename: (row: PlanRow, name: string | null) => void;
};

/** 編集済みの印が無い本に渡す空の並び。毎回作ると、行の描き直しを省けない */
const NOT_EDITED: readonly string[] = [];

/**
 * 一覧の 1 行。props が変わった行だけを描き直す（#168）。本が数千冊あると、
 * 全部の行を描き直すたびに画面が目に見えて固まる
 */
const PlanListRow = memo(function PlanListRow({
  row,
  madePath,
  madeSize,
  sameVolume,
  checkable,
  state,
  name,
  outputDirectory,
  locked,
  handlers,
  edited,
  corrected,
  renamed,
  collided,
}: PlanListRowProps) {
  // 整理して出来た本（#172）。もう処理の対象ではないのでチェックを出さず、
  // 薄めもしない。入れ物は、下の本が全部出来ていれば同じ扱い
  const done = row.kind === "book" ? madePath !== undefined : !checkable;
  const off = state === false && !done;
  // 整理済みでない本は「元 → 結果」で見せ、巻数をその場で直せる（段階 5）
  const correctable = row.kind === "book" && !row.organized;
  const dim = off ? DIMMED : undefined;
  // 整理済みの本は、既にディスク上に最終形で在る。整理を待たずにそのまま
  // 開けるので、行から次の作業へ渡せる（作る・作らないとは関わりが無い）。
  // 整理して出来た本も、出来た時点から同じに扱う（#160）
  const finished =
    row.kind === "book" && (row.organized || madePath !== undefined);
  const showsDestination = finished && state === true;
  // その本がいまディスク上の 1 つのファイルなら、ごみ箱へ移せるように
  // する（#163 #164）。整理して出来た本は出来たファイル、アーカイブ全体が
  // 1 冊の本はそのアーカイブ。1 つのアーカイブから出る本は、その本だけを
  // 消せないので出さない
  const file =
    madePath !== undefined
      ? { path: madePath, size: madeSize ?? null }
      : row.kind === "book" && row.size !== null
        ? { path: row.source, size: row.size }
        : null;

  return (
    <li
      data-testid="plan-row"
      data-kind={row.kind}
      data-level={0}
      data-path={row.path}
      data-source={row.source}
      data-entry={row.entry}
      data-output-name={row.kind === "book" ? name : ""}
      data-issues={[
        ...row.issues,
        ...(collided ? [VOLUME_DUPLICATE] : []),
      ].join(" ")}
      data-organized={String(row.organized)}
      data-organized-reason={row.organizedReason}
      data-made={madePath}
      data-existing={row.existing || undefined}
      // 印を出さない理由でも、行に乗せれば何が違うのかを読める。
      // 整理済みの行には説明を付けない（印そのものが説明を持っている）
      title={finished ? undefined : reasonTip(row) || undefined}
      tabIndex={0}
      role="row"
      style={{ paddingLeft: 8, gridTemplateColumns: GRID }}
      className={cn(
        // 1 行 28px。中身の背丈（印・近道）で行ごとに高さが揺れないよう
        // 下限で揃える
        "group grid min-h-7 w-max min-w-full items-center gap-2 rounded-control pr-2 py-0.5 outline-none",
        "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2",
        "focus-visible:ring-brand/40",
      )}
    >
      <span role="cell" className="flex items-center gap-2">
        {done ? (
          // チェックの幅だけ空けて、名前の位置をほかの行とそろえる
          <span aria-hidden className="size-4 shrink-0" />
        ) : (
          <Checkbox
            data-testid="plan-check"
            checked={state}
            disabled={locked}
            aria-label={row.kind === "book" ? name : row.path}
            title="Shift を押しながら押すと、前に押した行からここまでをまとめて切り替えます"
            // Shift で押すと、文字の選択が前に押した所まで伸びてしまう。押し下げで止める
            onMouseDown={(event) => {
              if (event.shiftKey) event.preventDefault();
            }}
            // Shift を読むために onClick で受ける。Space で押しても click が来る
            onClick={(event) =>
              handlers.toggle(row, state !== true, event.shiftKey)
            }
          />
        )}
        <RowIcon kind={row.kind} dim={dim} />
      </span>
      {correctable ? (
        <>
          <span
            role="cell"
            data-testid="plan-row-path"
            data-dim
            className={cn(
              "shrink-0 truncate text-[11.5px] text-ink-muted",
              dim,
            )}
            title={row.existing ? undefined : sourcePath(row)}
          >
            {/* 出力先に既にある本は、元の名前を持たない（#178） */}
            {row.existing ? null : <Origin row={row} corrected={corrected} />}
          </span>
          <ArrowRight
            data-testid="volume-arrow"
            className="size-3 shrink-0 text-ink-faint"
          />
          <span
            role="cell"
            title={name}
            data-testid="plan-row-name"
            data-dim
            className={cn(
              "flex min-w-0 flex-1 items-center text-[12.5px]",
              dim,
            )}
          >
            {renamed ? (
              <span className="min-w-0 truncate">{name}</span>
            ) : (
              <ResultName
                name={name}
                row={row}
                corrected={corrected}
                // 出来た本は処理の対象ではないので、巻数も直させない
                locked={locked || done}
                onCorrect={handlers.correct}
                onFill={handlers.fill}
              />
            )}
            {!locked && !done && !row.existing ? (
              <FileNameEditor
                name={name}
                onChange={(name) => handlers.rename(row, name)}
              />
            ) : null}
          </span>
        </>
      ) : (
        <>
          <span
            role="cell"
            data-testid="plan-row-path"
            className={cn("min-w-0 truncate text-[11px] text-ink-muted", dim)}
            title={row.kind === "book" ? sourcePath(row) : row.path}
          >
            {row.existing
              ? "出力先の本"
              : row.kind === "book"
                ? where(row, showsDestination, outputDirectory)
                : row.path}
          </span>
          <ArrowRight className="size-3 text-ink-faint" />
          <span
            role="cell"
            data-testid="plan-row-name"
            title={name}
            className={cn("min-w-0 truncate text-[12.5px]", dim)}
          >
            {row.kind === "book" ? name : "解析中 / 目次を読めません"}
          </span>
        </>
      )}
      <span
        data-testid="plan-row-image-count"
        role="cell"
        className="tabular min-w-0 text-right pr-2 text-[11px] text-ink-muted"
        title="ZIP化対象の画像枚数"
      >
        {row.imageCount !== null ? `${row.imageCount}枚` : ""}
      </span>
      {/*
        右側は列の幅をそろえる（#172）。状態 → ごみ箱 → 近道。無い
        項目も幅だけ空けておき、行ごとに位置がずれないようにする
      */}
      <span role="cell" className="flex min-w-0 items-center">
        <RowStatus
          row={row}
          finished={finished}
          // 番号の付いた名前で出来ている本は、同じ巻の重複（#178）
          numbered={madePath !== undefined && NUMBERED.test(name)}
          sameVolume={sameVolume}
          collided={collided}
          dim={dim}
        />
      </span>
      <span role="cell" className="flex items-center gap-2">
        <span className="flex w-6 shrink-0 justify-center">
          {file && !locked ? (
            // 常に出す。乗せないと出ないと、消せることに気づけない（#172）
            <Button
              variant="ghost"
              size="icon"
              className="text-ink-faint hover:text-danger"
              data-testid="plan-trash"
              title={`${name} のファイルをごみ箱へ移す`}
              aria-label={`${name} のファイルをごみ箱へ移す`}
              onClick={() => handlers.trash({ ...file, name })}
            >
              <Trash2 />
            </Button>
          ) : null}
        </span>
        <span className="flex w-6 shrink-0">
          {finished ? (
            <EditShortcuts
              name={name}
              // 渡すのは今ディスク上に在るファイル。これから作られる行き先では
              // まだ開けない。整理して出来た本なら、出来たファイル
              path={madePath ?? row.source}
              edited={edited}
              testIdPrefix="plan"
              onOpen={handlers.openArchive}
            />
          ) : null}
        </span>
        <span className="flex w-6 shrink-0">
          {finished ? (
            <Button
              variant="ghost"
              size="icon"
              className="text-ink-faint"
              data-testid="plan-reset"
              title={`${name} の編集をすべて元に戻す`}
              aria-label={`${name} の編集をすべて元に戻す`}
              disabled={locked || edited.length === 0}
              onClick={() => handlers.reset(madePath ?? row.source)}
            >
              <Undo2 />
            </Button>
          ) : null}
        </span>
      </span>
    </li>
  );
});

/**
 * 行の状態の欄（#172）。整理済みなら「整理済み」の印、整理済みでない本に警告が
 * あれば警告のアイコンを 1 つだけ出す。
 *
 * 警告を 1 つずつ印にして横に並べると、肝心の巻数と名前が埋もれる。中身は
 * アイコンに乗せると出す。整理済みの印は薄めない。その行のチェックが外れて
 * いる理由そのものなので、一緒に薄めると答えが一番読みにくい所に置かれる。
 */
function RowStatus({
  row,
  finished,
  numbered,
  sameVolume,
  collided,
  dim,
}: {
  row: PlanRow;
  /** 整理済みか。整理して出来た本も含む（#160） */
  finished: boolean;
  /** 出来ている本が ``_1`` などの番号付きの名前か（#178） */
  numbered: boolean;
  sameVolume?: number;
  collided: boolean;
  dim?: string;
}) {
  if (numbered) {
    const text =
      (sameVolume
        ? `同じ巻の本が ${sameVolume} 冊あります。番号の付いた本は重複です`
        : "番号の付いた名前です") +
      "。残す本を決めたら、要らない本をごみ箱へ移してください。残りの番号は詰め直します";
    return (
      <span
        data-testid="plan-row-warning"
        data-duplicate
        role="img"
        aria-label={text}
        title={text}
        className="flex cursor-help items-center text-warn"
      >
        <TriangleAlert className="size-3.5" />
      </span>
    );
  }
  if (finished)
    return (
      <Badge tone="ok" data-testid="plan-row-state" title={ORGANIZED_TIP}>
        <CircleCheck className="size-3" />
        整理済み
      </Badge>
    );
  const warnings = rowWarnings(row, sameVolume, collided);
  if (warnings.length === 0) return null;
  const text = warnings.join("\n");
  return (
    <span
      data-testid="plan-row-warning"
      data-reason={
        REASON_BADGES[row.organizedReason] ? row.organizedReason : undefined
      }
      data-detail={row.organizedDetail || undefined}
      data-dim
      role="img"
      aria-label={text}
      title={text}
      className={cn("flex cursor-help items-center text-warn", dim)}
    >
      <TriangleAlert className="size-3.5" />
    </span>
  );
}

/**
 * 警告のアイコンに乗せると出す中身（#172）。1 行に 1 つ。
 *
 * 同じ巻の本の数と、名前が重なることは 1 つにまとめる。どちらも「同じ巻が
 * 複数ある」ことの言い換えで、別々に並べると同じことを 2 回言う。
 */
function rowWarnings(
  row: PlanRow,
  sameVolume: number | undefined,
  collided: boolean,
): string[] {
  const lines = row.issues.map(issueLabel);
  if (sameVolume)
    lines.push(
      `同じ巻の本が ${sameVolume} 冊あります` +
        (collided
          ? "。名前が重なるので、後から作る本に _1 などの番号を付けます"
          : ""),
    );
  else if (collided) lines.push(issueLabel(VOLUME_DUPLICATE));
  if (REASON_BADGES[row.organizedReason]) lines.push(reasonTip(row));
  return lines;
}

/** ごみ箱へ移す本のファイル。確かめる窓に名前と大きさを出す */
export type TrashTarget = { path: string; size: number | null; name: string };

/** ファイルの大きさの表示。10 未満だけ小数 1 桁にする（例: 8.4 MB, 152 MB） */
export function sizeLabel(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown =
    value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}

/** パスの末尾。場所は隣の欄が受け持つ */
function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function sourcePath(row: PlanRow): string {
  return row.entry ? `${row.source} / ${row.entry}` : row.source;
}

/** 長い元パスは中央を省略し、名前と投入元の両方を残す。 */
function shortPath(path: string): string {
  return path.length > 40 ? `${path.slice(0, 10)}…${path.slice(-29)}` : path;
}

/** 本がどこから出来るか。アーカイブ全体が 1 冊なら位置は無い */
function origin(row: PlanRow): string {
  return `← ${shortPath(sourcePath(row))}`;
}

/**
 * 名前の隣に出す場所。行き先を指すときだけ、元ではなく出力先を出す。
 *
 * 行き先に変えるのは、整理済みの本を入れ直したときだけ（#73 段階 4c）。
 * 入れ直すと指定した出力先へ作るため、その行き先を予告する。
 * 既定で外れている間は実際の保存場所を指す。まだディスク上に無い本で行き先を
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

/**
 * 本の行の「元の名前」。巻数を読んだ名前を出し、読んだ数字だけを塗る。
 *
 * 元パスとアーカイブ内の位置を合わせ、長ければ中央を省略する。
 * 名前から読めず並び順を当てはめただけなら「並び順 N」と添える。
 */
function Origin({ row, corrected }: { row: PlanRow; corrected: boolean }) {
  const main = shortPath(sourcePath(row));
  const read =
    row.volumeOrigin === "pattern" || row.volumeOrigin === "last-number"
      ? readDigits(main, row.autoVolume)
      : null;
  // 直した後は、読んだ数字は根拠として薄く残すだけにする
  const tone = corrected
    ? "faint"
    : row.issues.includes(VOLUME_UNCERTAIN)
      ? "warn"
      : "brand";
  return (
    <>
      {read ? (
        <>
          {read.before}
          <mark
            data-testid="volume-read"
            data-tone={tone}
            className={cn(
              "rounded-[2px] bg-transparent px-px font-semibold",
              tone === "warn"
                ? "bg-warn/15 text-warn"
                : tone === "brand"
                  ? "bg-brand/15 text-brand"
                  : "text-ink-muted",
            )}
          >
            {read.digits}
          </mark>
          {read.after}
        </>
      ) : (
        main
      )}
      {row.volumeOrigin === "position" ? (
        <span className="ml-1.5 text-[11px] text-ink-faint">
          並び順 {row.autoVolume}
        </span>
      ) : null}
    </>
  );
}

/**
 * 出来上がる名前。作品名と著者は薄く、巻数の札と ``_1`` を目立たせる。
 *
 * 巻数は名前の中で直接直す。名前と別の欄に巻数を出すと、同じ数字が画面に
 * 2 回並ぶ。
 */
function ResultName({
  name,
  row,
  corrected,
  locked,
  onCorrect,
  onFill,
}: {
  name: string;
  row: PlanRow;
  corrected: boolean;
  locked: boolean;
  onCorrect: (row: PlanRow, volume: number | null) => void;
  onFill: (row: PlanRow, volume: number) => void;
}) {
  const label =
    row.volume === null
      ? "Unknown"
      : `第${String(row.volume).padStart(3, "0")}巻`;
  const at = name.lastIndexOf(label);
  const prefix = at >= 0 ? name.slice(0, at) : "";
  const suffix = at >= 0 ? name.slice(at + label.length) : name;
  return (
    <>
      <span className="min-w-0 truncate text-ink-faint">{prefix}</span>
      <VolumeChip
        label={label}
        value={row.volume}
        corrected={corrected}
        locked={locked}
        onCommit={(volume) => onCorrect(row, volume)}
        onFill={(volume) => onFill(row, volume)}
      />
      <span className={cn("shrink-0", suffix.startsWith("_") && "text-warn")}>
        {suffix}
      </span>
    </>
  );
}

/** 打った文字を巻数として読む。空は Unknown、数字以外は読めない（undefined） */
function parseVolume(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * 巻数の札。押すとその場で「第 [ ] 巻」の入力に変わる。
 *
 * Enter で決める / Esc でやめる / ↑↓ で決めて隣の本の札へ /
 * Ctrl+Enter で決めて同じ入れ物の下の本に続き番号。数字以外を打って
 * 離れたら、何も変えない。
 */
function VolumeChip({
  label,
  value,
  corrected,
  locked,
  onCommit,
  onFill,
}: {
  label: string;
  value: number | null;
  corrected: boolean;
  locked: boolean;
  onCommit: (volume: number | null) => void;
  onFill: (volume: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  // 決めた・やめた後に届く blur で、もう一度決めないための印
  const settled = useRef(false);

  const open = () => {
    settled.current = false;
    setText(value === null ? "" : String(value));
    setEditing(true);
  };

  const finish = (commit: boolean) => {
    if (settled.current) return undefined;
    settled.current = true;
    setEditing(false);
    const parsed = parseVolume(text);
    if (commit && parsed !== undefined) onCommit(parsed);
    return parsed;
  };

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const parsed = finish(true);
      if ((event.ctrlKey || event.metaKey) && typeof parsed === "number")
        onFill(parsed);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const row = event.currentTarget.closest("li");
      finish(true);
      openNeighbor(row, event.key === "ArrowDown" ? 1 : -1);
    }
  };

  if (editing) {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-control border border-brand bg-canvas px-1 text-brand">
        第
        <input
          data-testid="volume-input"
          // 押した直後に打てるようにする。札から入力へ替わったことが分かる
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          inputMode="numeric"
          aria-label="巻数"
          value={text}
          className="w-10 bg-transparent text-center text-ink outline-none"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKey}
          onBlur={() => finish(true)}
          onFocus={(event) => event.currentTarget.select()}
        />
        巻
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid="volume-chip"
      data-corrected={String(corrected)}
      disabled={locked}
      title="押すと巻数を直せます（Enter 決める / Esc やめる / ↑↓ 隣の本 / Ctrl+Enter 下の本に続き番号 / 空にすると Unknown）"
      className={cn(
        "shrink-0 rounded-control border px-1 font-medium",
        corrected
          ? "border-brand/60 bg-brand/15 text-brand"
          : "border-line text-ink hover:border-line-strong",
      )}
      onClick={open}
    >
      {label}
    </button>
  );
}

/** 隣の本の行にある巻数の札を開く。描き直しを待ってから押す */
function openNeighbor(row: Element | null, step: 1 | -1) {
  let next = row;
  do {
    next =
      step === 1
        ? (next?.nextElementSibling ?? null)
        : (next?.previousElementSibling ?? null);
  } while (next && !next.querySelector('[data-testid="volume-chip"]'));
  if (!next) return;
  const target = next;
  requestAnimationFrame(() =>
    target
      .querySelector<HTMLButtonElement>('[data-testid="volume-chip"]')
      ?.click(),
  );
}
