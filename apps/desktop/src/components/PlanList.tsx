import {
  ArrowRight,
  BookMarked,
  CircleCheck,
  Folder,
  Image as ImageIcon,
  Info,
  ListOrdered,
  Package,
  TriangleAlert,
} from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import {
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
import { SHORTCUT_SIZE, type HandoffMode } from "./ProducedList";
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

/** 1 段ぶんの字下げ。3 階層でも左端の情報量を潰さない幅 */
const INDENT_PX = 14;

/**
 * 本の行の「元の名前」の欄の幅（一番浅い本の行で）。深い行ほど字下げの
 * ぶん狭めて、矢印が全部の行で同じ位置に並ぶようにする。番号の柱を縦に
 * 目で走査できるようにするため。
 */
const ORIGIN_WIDTH_PX = 260;

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
 * 行に乗せている間だけ見せる操作（近道）の見え方。
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
  /** 整理済みの本を、そのまま次の画面へ読み込ませる */
  onOpenArchive: (path: string, mode: HandoffMode) => void;
  /** 利用者が巻数を直した本の鍵 */
  corrected: ReadonlySet<string>;
  /** 作る本どうしで名前が重なった本の鍵 */
  collided: ReadonlySet<string>;
  /** 巻数を直す。null は Unknown */
  onCorrect: (row: PlanRow, volume: number | null) => void;
  /** 直したうえで、同じ入れ物の下の本に続き番号を振る */
  onFill: (row: PlanRow, volume: number) => void;
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
  onOpenArchive,
  corrected,
  collided,
  onCorrect,
  onFill,
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
          onOpenArchive={onOpenArchive}
          corrected={corrected.has(row.id)}
          collided={collided.has(row.id)}
          onCorrect={onCorrect}
          onFill={onFill}
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
  onOpenArchive: (path: string, mode: HandoffMode) => void;
  corrected: boolean;
  collided: boolean;
  onCorrect: (row: PlanRow, volume: number | null) => void;
  onFill: (row: PlanRow, volume: number) => void;
};

function PlanListRow({
  row,
  state,
  name,
  outputDirectory,
  locked,
  onToggle,
  onOpenArchive,
  corrected,
  collided,
  onCorrect,
  onFill,
}: PlanListRowProps) {
  const off = state === false;
  // 整理済みでない本は「元 → 結果」で見せ、巻数をその場で直せる（段階 5）
  const correctable = row.kind === "book" && !row.organized;
  const dim = off ? DIMMED : undefined;
  // 整理済みの本は、既にディスク上に最終形で在る。整理を待たずにそのまま
  // 開けるので、行から次の作業へ渡せる（作る・作らないとは関わりが無い）
  const finished = row.kind === "book" && row.organized;
  const showsDestination = finished && state === true;

  return (
    <li
      data-testid="plan-row"
      data-kind={row.kind}
      data-level={row.level}
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
      // 印を出さない理由でも、行に乗せれば何が違うのかを読める。
      // 整理済みの行には説明を付けない（印そのものが説明を持っている）
      title={reasonTip(row) || undefined}
      tabIndex={0}
      style={{ paddingLeft: 8 + row.level * INDENT_PX }}
      className={cn(
        // 1 行 28px。中身の背丈（印・近道）で行ごとに高さが揺れないよう
        // 下限で揃える
        "group flex min-h-7 items-center gap-2 rounded-control pr-2 py-0.5 outline-none",
        "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2",
        "focus-visible:ring-brand/40",
      )}
    >
      <Checkbox
        data-testid="plan-check"
        checked={state}
        disabled={locked}
        aria-label={row.kind === "book" ? name : row.path}
        onCheckedChange={() => onToggle(row, state !== true)}
      />
      <RowIcon kind={row.kind} dim={dim} />
      {correctable ? (
        <>
          <span
            data-testid="plan-row-path"
            data-dim
            className={cn(
              "shrink-0 truncate text-[11.5px] text-ink-muted",
              dim,
            )}
            style={{ width: ORIGIN_WIDTH_PX - (row.level - 1) * INDENT_PX }}
            title={[basename(row.source), row.entry]
              .filter(Boolean)
              .join(" / ")}
          >
            <Origin row={row} corrected={corrected} />
          </span>
          <ArrowRight
            data-testid="volume-arrow"
            className="size-3 shrink-0 text-ink-faint"
          />
          <span
            data-testid="plan-row-name"
            data-dim
            className={cn("min-w-0 flex-1 truncate text-[12.5px]", dim)}
          >
            <ResultName
              name={name}
              row={row}
              corrected={corrected}
              locked={locked}
              onCorrect={onCorrect}
              onFill={onFill}
            />
          </span>
        </>
      ) : (
        <>
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
        </>
      )}
      <RowBadges row={row} collided={collided} dim={dim} />
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
function RowBadges({
  row,
  collided,
  dim,
}: {
  row: PlanRow;
  collided: boolean;
  dim?: string;
}) {
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
          data-detail={row.organizedDetail}
          data-dim
          className={dim}
          title={reasonTip(row)}
        >
          <Info className="size-3" />
          {reasonBadge}
        </Badge>
      ) : null}
      {[...row.issues, ...(collided ? [VOLUME_DUPLICATE] : [])].map((issue) => (
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

/**
 * 本の行の「元の名前」。巻数を読んだ名前を出し、読んだ数字だけを塗る。
 *
 * 入れ子のアーカイブは外側の名前で巻数を読む。そのときは外側を主に出し、
 * 内側は薄く添える。薄いことで「この名前の数字は使われていない」が分かる。
 * 名前から読めず並び順を当てはめただけなら「並び順 N」と添える。
 */
function Origin({ row, corrected }: { row: PlanRow; corrected: boolean }) {
  const archive = basename(row.source);
  const readOuter =
    row.entry !== "" &&
    row.volumeSourceName !== "" &&
    !row.entry.includes(row.volumeSourceName);
  const main = row.entry === "" || readOuter ? archive : row.entry;
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
      {readOuter ? <span className="text-ink-faint">/{row.entry}</span> : null}
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
      <span className="text-ink-faint">{prefix}</span>
      <VolumeChip
        label={label}
        value={row.volume}
        corrected={corrected}
        locked={locked}
        onCommit={(volume) => onCorrect(row, volume)}
        onFill={(volume) => onFill(row, volume)}
      />
      <span className={suffix.startsWith("_") ? "text-warn" : undefined}>
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
      <span className="inline-flex items-center gap-0.5 rounded-control border border-brand bg-canvas px-1 text-brand">
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
        "rounded-control border px-1 font-medium",
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
