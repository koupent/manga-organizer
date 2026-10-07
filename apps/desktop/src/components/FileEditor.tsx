import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { EditablePage } from "./EditablePage";
import { CoverEditor } from "./CoverEditor";
import { useStoredString } from "../lib/setting";
import {
  ChevronLeft,
  ChevronRight,
  Link2,
  Loader2,
  Save,
  Scissors,
  Undo2,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { CoverRequest, SidecarClient } from "../api/client";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Empty } from "./ui/empty";
import { Segmented } from "./ui/segmented";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { EditorLayout } from "./EditorLayout";
import { MergeCard, type PickRole } from "./MergeCard";
import { SplitCard } from "./SplitCard";
import { SplitDialog } from "./SplitDialog";
import { useStoredNumber } from "../lib/setting";
import { useSplitJob } from "../lib/split-job";
import { useBoxSize } from "../lib/stage";
import { cn } from "../lib/utils";
import {
  firstStep,
  isAbsorbed,
  isCandidate,
  isMergeCandidate,
  isMergeTarget,
  isPending,
  isSplitTarget,
  isWide,
  joinedRows,
  mergeAll,
  mergeUnits,
  numberLabel,
  pageNumbers,
  partnersOf,
  replaceRow,
  splitAll,
  summaryOf,
  type MergeUnit,
  type SplitRow,
  type SplitSource,
  type Step,
} from "../lib/split";

/**
 * 表示サイズ（カード 1 枚の最小幅・px）の可動域と既定。
 *
 * 1280px の窓に単ページが 7 枚並ぶ密度を既定にする。
 */
const CARD_WIDTH_MIN = 140;
const CARD_WIDTH_MAX = 520;
const CARD_WIDTH_STEP = 20;
const CARD_WIDTH_DEFAULT = 160;

/** 既存の表示サイズ設定を引き継ぐ */
const CARD_WIDTH_KEY = "split.cardWidth";

/** 格子の隙間（gap-3）。列の幅を出すのに要る */
const GRID_GAP = 12;

/** 絵の箱の高さ／列の幅。縦長ページ（2:3）がちょうど収まる比 */
const PICTURE_RATIO = 1.5;

/** ステップごとの説明。見出しの下に 1 行で出す */
const GUIDES: Record<Step, string> = {
  split:
    "画像を 2 ページに分けます ・ 線を掴むと分ける位置を動かせます ・ 画像をクリックで大きく表示",
  merge:
    "端の絵がつながる 2 ページを候補にしています ・ 候補に無い 2 ページは「結合…」を押してから相手を押す ・ 保存済みの画像を分けるときは「ページを分割」へ",
};

type FileEditorProps = {
  client: SidecarClient;
  archive: string;
  active: boolean;
  /** アーカイブを書き換えたことを伝える。他の画面が持つページは古くなる */
  onArchiveChanged?: () => void;
};

/** ステップの切り替えに出す名前と、残りの件数 */
function StepLabel({ text, count }: { text: string; count: number }) {
  return (
    <>
      {text}
      {count > 0 ? (
        <span className="tabular ml-1.5 opacity-75">{count}</span>
      ) : null}
    </>
  );
}

/** 共通のページ一覧で、表紙・分割結合・ページ順を編集する。変更は保存時にまとめて反映する。 */
export function FileEditor({
  client,
  archive,
  active,
  onArchiveChanged,
}: FileEditorProps) {
  const {
    rows,
    pageCount,
    progress,
    report,
    busy,
    reloadKey,
    editRows,
    restore,
    confirm,
    reordered,
  } = useSplitJob({ client, archive, onArchiveChanged });

  // 利用者が選んだステップ。選ぶまでは、開いた本の中身から決める（firstStep）
  const [chosen, setChosen] = useState<Step | null>(null);
  const [splitSource, setSplitSource] = useState<SplitSource>("original");
  // 表示方向はページ順を変えず、画面の並びだけに適用する
  const [direction, setDirection] = useStoredString("editor.direction");
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [coverDraft, setCoverDraft] = useState<CoverRequest | undefined>();
  const [reviewed, setReviewed] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const lastClicked = useRef<string | null>(null);
  const [history, setHistory] = useState<
    { rows: SplitRow[]; cover?: CoverRequest }[]
  >([]);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const [overlay, setOverlay] = useState<number | null>(null);
  // 前後の送りボタンで指している行（#131）。数百ページの本で、対象を探して
  // 格子をスクロールさせずに済むようにする。絞り込まないのは、前後の
  // ページとのつながりが見えなくなるため
  const [focus, setFocus] = useState<number | null>(null);
  const [cardWidth, setCardWidth] = useStoredNumber(
    CARD_WIDTH_KEY,
    CARD_WIDTH_DEFAULT,
  );
  // 列の幅は auto-fill が決める。実測してから絵の箱の寸法を導く
  const [gridRef, gridSize] = useBoxSize<HTMLDivElement>();
  // ②の「結合…」で相手を選び始めたカード（MergeUnit の key）（#154）
  const [picking, setPicking] = useState<string | null>(null);

  // 読み直すと行が減ることがある。開いたままの重ね枠が、もう無い行を
  // 指したままにならないよう閉じる
  useEffect(() => {
    setOverlay(null);
    setFocus(null);
    setPicking(null);
    setCoverDraft(undefined);
    setHistory([]);
    setSelection([]);
    setZoomed(null);
  }, [reloadKey]);

  // 相手を選んでいる間は Esc でやめられる
  useEffect(() => {
    if (picking === null) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setPicking(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

  const undo = () => {
    const previous = history.at(-1);
    if (!previous || busy) return;
    editRows(previous.rows);
    setCoverDraft(previous.cover);
    setHistory(history.slice(0, -1));
    setPicking(null);
  };
  useEffect(() => {
    if (!active || busy) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setZoomed(null);
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea,[contenteditable],[role=dialog]"))
        return;
      if ((event.ctrlKey || event.metaKey) && event.key === "z") {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (rows === null) {
    return (
      <section className="flex min-h-0 flex-1 flex-col gap-2">
        {/* 読み込み中も作業面の取り分は同じ。ここで面が縮むと、待っている
            間だけ画面が縦に動く */}
        <div
          data-testid="split-loading"
          className="flex min-h-0 flex-1 flex-col justify-center"
        >
          <Empty
            icon={
              report.state === "error" ? undefined : (
                <Loader2 className="animate-spin" />
              )
            }
            title={
              report.state === "error" ? report.message : "読み込んでいます..."
            }
          >
            {report.state === "error" || progress.total === 0
              ? null
              : `見開きを判定しています · ${progress.current} / ${progress.total} ページ`}
          </Empty>
        </div>
      </section>
    );
  }

  const step = chosen ?? firstStep(rows);
  const numbers = pageNumbers(rows);
  const pending = rows.some(isPending) || reordered || Boolean(coverDraft);
  const status =
    report.state === "idle"
      ? [
          reordered ? "ページ順を変更します" : "",
          coverDraft ? "サムネイルの画像調整を反映します" : "",
          rows.some(isPending) ? summaryOf(rows) : "",
        ]
          .filter(Boolean)
          .join(" · ") || "変更はありません"
      : report.message;

  // ステップごとの対象。送りボタンはこれを辿る。件数は本に書かれている状態で
  // 数えるので、選んでも減らない
  const splitTargets = rows
    .map((row, index) => (isSplitTarget(row, splitSource) ? index : -1))
    .filter((index) => index >= 0);
  const mergeTargets = rows
    .map((_, index) => (isMergeTarget(rows, index) ? index : -1))
    .filter((index) => index >= 0);
  const targets = step === "split" ? splitTargets : mergeTargets;
  const canSplitAll = splitTargets.some((index) => !rows[index].checked);
  const canMergeAll = mergeTargets.some((index) =>
    isMergeCandidate(rows, index)
      ? !rows[index].mergeNext
      : rows[index].checked,
  );

  // 列の幅は auto-fill が決める。同じ規則で数えてから、絵の箱をそこへ合わせる
  const columns = Math.max(
    1,
    Math.floor((gridSize.width + GRID_GAP) / (cardWidth + GRID_GAP)),
  );
  const columnWidth =
    gridSize.width > 0
      ? (gridSize.width - (columns - 1) * GRID_GAP) / columns
      : 0;
  const pictureHeight = columnWidth * PICTURE_RATIO;

  // 行を変えたら、選びかけの相手は捨てる。並びが変わり、もう選べないことがある
  const edit = (next: SplitRow[]) => {
    if (busy) return;
    setHistory((past) => [...past, { rows, cover: coverDraft }].slice(-100));
    setPicking(null);
    editRows(next);
  };
  const select = (name: string, event: MouseEvent) => {
    const names = rows.flatMap((row) => row.names);
    if (event.shiftKey && lastClicked.current) {
      const [from, to] = [
        names.indexOf(lastClicked.current),
        names.indexOf(name),
      ].sort((a, b) => a - b);
      setSelection(names.slice(from, to + 1));
    } else if (event.ctrlKey || event.metaKey) {
      setSelection((current) =>
        current.includes(name)
          ? current.filter((item) => item !== name)
          : [...current, name],
      );
      lastClicked.current = name;
    } else {
      setSelection([name]);
      lastClicked.current = name;
    }
  };

  const setChecked = (index: number, checked: boolean) =>
    edit(replaceRow(rows, index, { checked }));

  const setSplit = (index: number, x: number) =>
    edit(replaceRow(rows, index, { x }));

  const setMerge = (index: number, mergeNext: boolean) =>
    edit(replaceRow(rows, index, { mergeNext }));

  /**
   * 未保存の変更を残してモードを移る。保存と読み直しの最中は移らない
   */
  const requestStep = (next: Step) => {
    if (busy) return;
    setChosen(next);
    setSelection([]);
    setFocus(null);
    setPicking(null);
  };
  const save = async () => {
    if (await confirm(coverDraft)) {
      setReviewed(true);
      if (step === "split") setChosen("merge");
    }
  };

  // 分割済みの対を個別に動かすときだけ、保存済みの 2 ページとして扱う。
  const separatePages = (items: SplitRow[]) =>
    items.flatMap((row) => {
      if (row.names.length !== 2 || !row.checked || isPending(row))
        return [row];
      return row.names.map((name, part) => ({
        ...row,
        names: [name],
        width: part === 0 ? row.width - row.x : row.x,
        source: "page",
        detected: false,
        checked: false,
        displaced: false,
        keptWhole: false,
        rejoin: false,
        suggested: false,
        stored: { checked: false, x: row.x },
      }));
    });
  const chooseCover = (name: string) => {
    const next = separatePages(rows);
    const index = next.findIndex((row) => row.names.includes(name));
    if (
      index < 0 ||
      next[index].mergeNext ||
      isAbsorbed(next, index) ||
      isPending(next[index])
    )
      return;
    setCoverDraft(undefined);
    edit(
      [next[index], ...next.filter((_, at) => at !== index)].map((row) => ({
        ...row,
        suggested: false,
      })),
    );
  };
  const dragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || busy) return;
    const next = separatePages(rows);
    const from = next.findIndex((row) => row.names.includes(String(active.id)));
    const to = next.findIndex((row) => row.names.includes(String(over.id)));
    if (from < 0 || to < 0) return;
    const selected = selection.includes(String(active.id))
      ? selection
      : [String(active.id)];
    // 表示中のカードに含まれるページは、候補や分割済みの対も一緒に運ぶ。
    const movingNames = new Set(
      pageGroups
        .filter((names) => names.some((name) => selected.includes(name)))
        .flat(),
    );
    if (movingNames.has(String(over.id))) return;
    const moving = next.filter((row) =>
      row.names.some((name) => movingNames.has(name)),
    );
    const remaining = next.filter(
      (row) => !row.names.some((name) => movingNames.has(name)),
    );
    const at = remaining.findIndex((row) =>
      row.names.includes(String(over.id)),
    );
    const targetNames =
      pageGroups.find((names) => names.includes(String(over.id))) ?? [];
    const targetCount = remaining.filter((row) =>
      row.names.some((name) => targetNames.includes(name)),
    ).length;
    remaining.splice(at + (from < to ? targetCount : 0), 0, ...moving);
    edit(remaining.map((row) => ({ ...row, suggested: false })));
  };

  // 拡大表示は 1 枚を割る道具なので、そこで辿るのは分割の候補だけ
  const candidates = rows
    .map((row, index) => (isCandidate(row, splitSource) ? index : -1))
    .filter((index) => index >= 0);

  /**
   * from の前後の対象。端まで来たら反対の端へ循環する。対象が無ければ undefined。
   *
   * 選ぶのは「from より後ろ／前にある最初の対象」で、対象の並びの中での位置では
   * ない。対象でない行からも拡大表示は開くので、その行が対象の並びに居ないことを
   * 勘定に入れないと、→ を押した利用者が本の先頭側へ飛ばされる。
   */
  const candidateFrom = (list: number[], from: number, delta: number) => {
    const behind = list.filter((index) => index < from);
    const ahead = list.filter((index) => index > from);
    return delta > 0 ? (ahead[0] ?? list[0]) : (behind.at(-1) ?? list.at(-1));
  };

  /** 拡大表示の中で、前後の候補へ移る */
  const walk = (delta: number) => {
    if (overlay === null) return;
    const next = candidateFrom(candidates, overlay, delta);
    if (next !== undefined) setOverlay(next);
  };

  // 見出しの送りボタンの起点。まだ何も指していなければ、本の端から数える
  const focusFrom = (delta: number) => focus ?? (delta > 0 ? -1 : rows.length);
  const previous = candidateFrom(targets, focusFrom(-1), -1);
  const following = candidateFrom(targets, focusFrom(1), 1);

  /**
   * 前後の対象を指し、格子の中央まで送る。カードへフォーカスも移すので、
   * そのまま Enter で切り替えられる
   */
  const pointAt = (target: number | undefined) => {
    if (target === undefined) return;
    setFocus(target);
    const card = document.querySelector<HTMLElement>(
      `[data-index="${target}"][tabindex]`,
    );
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const focusedAt = focus === null ? -1 : targets.indexOf(focus);

  /**
   * 指した対象を切り替える。①は分ける・分けない、②は結合する・しない
   * （割った対の候補は、割る前へ戻す・戻さない）
   */
  const toggleTarget = (index: number) =>
    step === "merge" && isMergeCandidate(rows, index)
      ? setMerge(index, !rows[index].mergeNext)
      : setChecked(index, !rows[index].checked);

  /**
   * 指したカードでのキー操作。Enter で切り替えて次の対象へ進む。← → で前後の
   * 対象へ送る。カードの中のボタンや線を掴んでいるときは、その部品の操作を
   * 優先する
   */
  const onCardKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const card = event.target as HTMLElement;
    if (!card.hasAttribute("tabindex") || busy) return;
    const index = Number(card.dataset.index);
    if (event.key === "Enter") {
      if (!targets.includes(index)) return;
      event.preventDefault();
      toggleTarget(index);
      pointAt(candidateFrom(targets, index, 1));
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      pointAt(
        candidateFrom(targets, index, event.key === "ArrowRight" ? 1 : -1),
      );
    }
  };

  const imageUrlOf = (row: SplitRow) =>
    `${
      row.source === "original"
        ? client.originalUrl(archive, row.names[0])
        : client.imageUrl(archive, row.names[0])
    }&v=${reloadKey}`;

  const pictureOf = (row: SplitRow) => ({
    imageUrl:
      row.source === "original"
        ? imageUrlOf(row)
        : `${client.thumbnailUrl(archive, row.names[0], cardWidth)}&v=${reloadKey}`,
    width: row.width,
    height: row.height,
  });

  /**
   * 割った対の半分の絵。寸法は割った位置から見積もる（先に読む右半分は
   * x から右、後の左半分は x まで）
   */
  const halfOf = (row: SplitRow, part: 0 | 1) => ({
    imageUrl: `${client.thumbnailUrl(archive, row.names[part], cardWidth)}&v=${reloadKey}`,
    width: part === 0 ? row.width - row.x : row.x,
    height: row.height,
  });

  // ②の並び（#154）。割った対は 2 枚の単ページとして出す
  const units: MergeUnit[] = step === "merge" ? mergeUnits(rows) : [];
  const pageGroups =
    step === "split"
      ? rows.flatMap((row, index) =>
          isAbsorbed(rows, index)
            ? []
            : [
                row.mergeNext
                  ? [...row.names, ...rows[index + 1].names]
                  : row.names,
              ],
        )
      : units.map((unit) => {
          const row = rows[unit.row];
          if (unit.part !== undefined) return [row.names[unit.part]];
          return unit.via === "merge"
            ? [...row.names, ...rows[unit.row + 1].names]
            : row.names;
        });
  const pickedUnit = units.find((unit) => unit.key === picking) ?? null;
  const pickable = pickedUnit ? partnersOf(rows, units, pickedUnit) : [];
  const roleOf = (unit: MergeUnit): PickRole =>
    pickedUnit === null
      ? "none"
      : unit.key === pickedUnit.key
        ? "self"
        : pickable.includes(unit.key)
          ? "partner"
          : "dimmed";

  const opened = overlay === null ? null : (rows[overlay] ?? null);

  const renderSplitCard = (row: SplitRow, index: number) => {
    // 結合の相手はまとめたカードに含める。保存済みの結合は横長の 1 枚になる
    if (isAbsorbed(rows, index)) return null;
    const wide = isWide(row);
    const span = wide && columns >= 2;
    return (
      <EditablePage
        key={row.names[0]}
        id={row.names[0]}
        name={row.names[0]}
        span={span}
        cover={index === 0}
        disabled={busy}
        selected={selection.includes(row.names[0])}
        onSelect={(event) => select(row.names[0], event)}
        onZoom={() => setZoomed(row.names[0])}
        canCover={!isPending(row) && !isAbsorbed(rows, index)}
        onCover={() => chooseCover(row.names[0])}
        onAdjust={() => setAdjusting(row.names[0])}
      >
        <div
          inert={busy || coverDraft?.name === row.names[0]}
          className={
            coverDraft?.name === row.names[0]
              ? "pointer-events-none opacity-70"
              : undefined
          }
        >
          <SplitCard
            key={index}
            index={index}
            label={numberLabel(numbers[index])}
            pending={isPending(row)}
            applied={row.stored.checked && row.checked}
            focused={focus === index}
            checked={row.checked}
            target={isSplitTarget(row, splitSource)}
            keptWhole={row.keptWhole}
            wide={wide}
            span={span}
            boxWidth={span ? columnWidth * 2 + GRID_GAP : columnWidth}
            boxHeight={pictureHeight}
            width={row.width}
            height={row.height}
            x={row.x}
            imageUrl={imageUrlOf(row)}
            onToggle={() => setChecked(index, !row.checked)}
            onMoveSplit={(x) => setSplit(index, x)}
            onZoom={() => setOverlay(index)}
          />
        </div>
      </EditablePage>
    );
  };

  const renderMergeCard = (unit: MergeUnit) => {
    const index = unit.row;
    const row = rows[index];
    const merging = unit.via === "merge";
    const partner =
      merging && (unit.kind === "candidate" || unit.kind === "joined")
        ? rows[index + 1]
        : null;
    const wide =
      unit.kind === "spread" || partner !== null || unit.via === "rejoin";
    const span = wide && columns >= 2;
    const label =
      unit.part !== undefined
        ? String(numbers[index][unit.part])
        : unit.kind === "candidate" && merging
          ? // 候補はまだ 2 ページのまま
            numberLabel([numbers[index][0], numbers[index + 1][0]])
          : numberLabel(numbers[index]);
    const role = roleOf(unit);
    return (
      <EditablePage
        key={row.names[unit.part ?? 0]}
        id={row.names[unit.part ?? 0]}
        name={row.names[unit.part ?? 0]}
        span={span}
        cover={index === 0 && (unit.part ?? 0) === 0}
        disabled={busy}
        selected={selection.includes(row.names[unit.part ?? 0])}
        onSelect={(event) => select(row.names[unit.part ?? 0], event)}
        onZoom={() => setZoomed(row.names[unit.part ?? 0])}
        canCover={!isPending(row) && !isAbsorbed(rows, index)}
        onCover={() => chooseCover(row.names[unit.part ?? 0])}
        onAdjust={() => setAdjusting(row.names[unit.part ?? 0])}
      >
        <div
          inert={busy || coverDraft?.name === row.names[unit.part ?? 0]}
          className={
            coverDraft?.name === row.names[unit.part ?? 0]
              ? "pointer-events-none opacity-70"
              : undefined
          }
        >
          <MergeCard
            key={unit.key}
            index={index}
            part={unit.part}
            label={label}
            pending={isPending(row)}
            focused={focus === index && unit.part === undefined}
            kind={unit.kind}
            span={span}
            boxWidth={span ? columnWidth * 2 + GRID_GAP : columnWidth}
            boxHeight={pictureHeight}
            page={
              unit.part !== undefined ? halfOf(row, unit.part) : pictureOf(row)
            }
            partner={partner ? pictureOf(partner) : undefined}
            seamX={unit.via === "rejoin" ? row.x : undefined}
            pick={role}
            onMerge={
              unit.kind === "candidate" ? () => toggleTarget(index) : undefined
            }
            onCancelMerge={
              unit.kind === "joined" && merging
                ? () => setMerge(index, false)
                : unit.kind === "joined"
                  ? () => setChecked(index, true)
                  : undefined
            }
            onPick={
              partnersOf(rows, units, unit).length > 0
                ? () => setPicking(unit.key)
                : undefined
            }
            onChoose={
              pickedUnit && role === "partner"
                ? () => edit(joinedRows(rows, pickedUnit, unit))
                : undefined
            }
            onCancelPick={() => setPicking(null)}
          />
        </div>
      </EditablePage>
    );
  };

  return (
    <EditorLayout
      toolbar={
        <>
          <span className="shrink-0 text-[11px] text-ink-faint">
            モード選択
          </span>
          <Segmented<Step>
            items={[
              {
                id: "split",
                label: (
                  <StepLabel text="ページを分割" count={splitTargets.length} />
                ),
                testId: "split-step-split",
              },
              {
                id: "merge",
                label: (
                  <StepLabel text="ページを結合" count={mergeTargets.length} />
                ),
                testId: "split-step-merge",
              },
            ]}
            value={step}
            onChange={requestStep}
          />
          {step === "split" ? (
            <Button
              variant="secondary"
              className="shrink-0"
              data-testid="split-all"
              title="選んだ種類の画像を、分割線の位置ですべて分ける"
              disabled={!canSplitAll || busy}
              onClick={() => edit(splitAll(rows, splitSource))}
            >
              <Scissors />
              すべて分割
            </Button>
          ) : step === "merge" ? (
            <Button
              variant="secondary"
              className="shrink-0"
              data-testid="merge-all"
              title="結合の候補を、すべて 1 枚の見開きにする"
              disabled={!canMergeAll || busy}
              onClick={() => edit(mergeAll(rows))}
            >
              <Link2 />
              候補をすべて結合
            </Button>
          ) : null}
          <span className="flex shrink-0 items-center gap-1">
            <Button
              variant="secondary"
              size="icon"
              className="size-7"
              data-testid="split-previous"
              title="前の対象を指す"
              aria-label="前の対象を指す"
              disabled={previous === undefined}
              onClick={() => pointAt(previous)}
            >
              <ChevronLeft />
            </Button>
            <span
              className="tabular min-w-12 text-center text-[12px] text-ink-muted"
              data-testid="split-focus-position"
            >
              {focusedAt < 0 ? "–" : focusedAt + 1} / {targets.length}
            </span>
            <Button
              variant="secondary"
              size="icon"
              className="size-7"
              data-testid="split-next"
              title="次の対象を指す"
              aria-label="次の対象を指す"
              disabled={following === undefined}
              onClick={() => pointAt(following)}
            >
              <ChevronRight />
            </Button>
          </span>
          <div className="flex-1" />
          <span
            role="status"
            data-testid="split-status"
            data-state={report.state}
            title={status}
            className={cn(
              "max-w-[420px] truncate text-[12px]",
              report.state === "error" ? "text-danger" : "text-ink-muted",
            )}
          >
            {status}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            data-testid="undo"
            title="直前の編集を元に戻す（Ctrl+Z）"
            aria-label="直前の編集を元に戻す"
            disabled={history.length === 0 || busy}
            onClick={undo}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            data-testid="split-reset"
            title="変更を戻す（開いたときの状態に戻す）"
            aria-label="変更を戻す"
            disabled={!pending || busy}
            onClick={() => {
              setPicking(null);
              restore();
              setHistory([]);
              setSelection([]);
              setCoverDraft(undefined);
            }}
          >
            <Undo2 />
          </Button>
          {/* 書き込みが終わって新しい行が並ぶまで押させない。報告が done に
              なった時点で押せるようにすると、読み直しの最中に 2 つ目の指示が
              飛ぶ。着いた順で結果が決まり、利用者は自分が最後に選んだ内容と
              違う本を手にする */}
          <Button
            variant="primary"
            size="lg"
            className="shrink-0"
            data-testid="split-confirm"
            disabled={busy || (reviewed && !pending)}
            onClick={() => void save()}
          >
            <Save />
            {pending ? "変更を反映" : "確認済みにする"}
          </Button>
        </>
      }
      hint={
        <span className="flex items-center gap-3">
          {step === "split" ? (
            <span className="flex shrink-0 items-center gap-1.5">
              分割対象
              <Select
                value={splitSource}
                disabled={busy}
                onValueChange={(value: SplitSource) => {
                  setSplitSource(value);
                  setFocus(null);
                }}
              >
                <SelectTrigger data-testid="split-source" aria-label="分割対象">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="original">元から横長の画像</SelectItem>
                  <SelectItem value="edited">結合・復元した画像</SelectItem>
                  <SelectItem value="all">両方</SelectItem>
                </SelectContent>
              </Select>
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">
            {GUIDES[step]} ・ 取っ手で並べ替え ・ ⋮／右クリックでサムネイル選択
            ・ Ctrl／Shift＋名前クリックで複数選択
          </span>
          <label className="flex shrink-0 items-center gap-1.5">
            <input
              type="checkbox"
              data-testid="page-direction"
              checked={direction === "rtl"}
              onChange={(event) =>
                setDirection(event.target.checked ? "rtl" : "ltr")
              }
            />
            右から左に表示
          </label>
          <span data-testid="selection-count" className="shrink-0">
            {selection.length} 件選択
          </span>
          <span
            className="tabular shrink-0 text-ink-muted"
            data-testid="split-page-count"
          >
            {pageCount} ページ
          </span>
          <input
            type="range"
            min={CARD_WIDTH_MIN}
            max={CARD_WIDTH_MAX}
            step={CARD_WIDTH_STEP}
            value={cardWidth}
            title="表示サイズ"
            aria-label="表示サイズ"
            data-testid="split-card-width"
            onChange={(event) => setCardWidth(Number(event.target.value))}
            className="h-1 w-24 shrink-0 cursor-pointer accent-brand"
          />
        </span>
      }
    >
      {/* スクロールするのはこの箱であって窓ではない */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => {
          const name = String(active.id);
          if (!selection.includes(name)) setSelection([name]);
        }}
        onDragEnd={dragEnd}
      >
        <SortableContext
          items={pageGroups.map((names) => names[0])}
          strategy={rectSortingStrategy}
        >
          <div
            data-testid="split-grid"
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {/* 行の高さは中身に合わせる（auto-rows-max）。auto のままだと、
            高さの決まった格子を行数で割った高さへ押し込められる */}
            {/* カードのキー操作はここで受ける（onCardKey） */}
            {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
            <div
              ref={gridRef}
              dir={direction === "rtl" ? "rtl" : "ltr"}
              className="grid auto-rows-max content-start gap-3"
              style={{
                gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))`,
              }}
              onKeyDown={onCardKey}
            >
              {columnWidth > 0
                ? step === "split"
                  ? rows.map(renderSplitCard)
                  : units.map(renderMergeCard)
                : null}
            </div>
          </div>
        </SortableContext>
      </DndContext>

      {zoomed ? (
        <Dialog open onOpenChange={() => setZoomed(null)}>
          <DialogContent
            data-testid="lightbox"
            className="flex h-[90vh] w-[94vw] max-w-none! flex-col items-center"
            aria-describedby={undefined}
          >
            <DialogTitle>{zoomed}（Esc で閉じる）</DialogTitle>
            <img
              data-testid="lightbox-image"
              className="min-h-0 flex-1 object-contain"
              src={`${client.imageUrl(archive, zoomed)}&v=${reloadKey}`}
              alt={zoomed}
            />
          </DialogContent>
        </Dialog>
      ) : null}

      {step === "split" && opened !== null && overlay !== null ? (
        <SplitDialog
          label={numberLabel(numbers[overlay])}
          numbers={numbers[overlay]}
          checked={opened.checked}
          x={opened.x}
          width={opened.width}
          height={opened.height}
          imageUrl={imageUrlOf(opened)}
          onToggle={() => setChecked(overlay, !opened.checked)}
          onMoveSplit={(x) => setSplit(overlay, x)}
          onClose={() => setOverlay(null)}
          onWalk={walk}
        />
      ) : null}

      <Dialog
        open={adjusting !== null}
        onOpenChange={(open) => {
          if (!open) setAdjusting(null);
        }}
      >
        <DialogContent
          className="flex h-[88vh] w-[94vw] max-w-none! flex-col p-3"
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between">
            <DialogTitle>サムネイルの画像調整</DialogTitle>
            <Button variant="ghost" onClick={() => setAdjusting(null)}>
              キャンセル
            </Button>
          </div>
          {adjusting ? (
            <CoverEditor
              key={adjusting}
              client={client}
              archive={archive}
              pageName={adjusting}
              onDraft={(request) => {
                chooseCover(request.name);
                setCoverDraft(request);
                setAdjusting(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </EditorLayout>
  );
}
