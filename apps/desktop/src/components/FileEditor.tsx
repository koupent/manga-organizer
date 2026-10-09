import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { EditorSelection } from "./EditorSelection";
import { EditRestoreDialog } from "./EditRestoreDialog";
import { EditablePage } from "./EditablePage";
import { CoverEditor } from "./CoverEditor";
import { useStoredNumber, useStoredString } from "../lib/setting";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  RotateCcw,
  Save,
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
import { EditorLayout } from "./EditorLayout";
import { MergeCard, type PickRole } from "./MergeCard";
import { SplitCard } from "./SplitCard";
import { MarginControls, MarginProgress, useMarginJob } from "./MarginControls";
import { MarginCard, MarginFrame } from "./MarginCard";
import { SplitDialog } from "./SplitDialog";
import { useSplitJob } from "../lib/split-job";
import { fitInside, useBoxSize } from "../lib/stage";
import {
  isAbsorbed,
  isCandidate,
  isMergeCandidate,
  isMergeTarget,
  isPending,
  isSplitTarget,
  joinedRows,
  mergeAll,
  pairAllPages,
  separatePages,
  pageUnits,
  numberLabel,
  pageNumbers,
  partnersOf,
  replaceRow,
  splitAll,
  splitRow,
  summaryOf,
  type PageUnit,
  type SplitRow,
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
    busy: splitBusy,
    reloadKey,
    editRows,
    restore,
    confirm,
    reordered,
    refresh,
  } = useSplitJob({ client, archive, onArchiveChanged });

  // 余白は分割前の画像で揃えるため、最初に余白カットを開く。
  const [chosen, setChosen] = useState<Step | "trim">("trim");
  const [modeNotice, setModeNotice] = useState("");
  const [restoreMode, setRestoreMode] = useState<
    "all" | "trim" | "split" | "merge" | "thumbnail" | null
  >(null);
  const [restoring, setRestoring] = useState(false);
  const initialSplitSelection = useRef(false);
  const [bulkMerge, setBulkMerge] = useState(false);
  const [deletedVisibility, setDeletedVisibility] =
    useStoredString("editor.showDeleted");
  const showDeleted = deletedVisibility === "true";
  // 表示方向はページ順を変えず、画面の並びだけに適用する
  const [direction, setDirection] = useStoredString("editor.direction");
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [coverDraft, setCoverDraft] = useState<CoverRequest | undefined>();
  const [reviewed, setReviewed] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const lastClicked = useRef<string | null>(null);
  const [history, setHistory] = useState<
    { rows: SplitRow[]; cover?: CoverRequest; bulkMerge: boolean }[]
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
  // ②の「結合…」で相手を選び始めたカード（PageUnit の key）（#154）
  const [picking, setPicking] = useState<string | null>(null);

  // 読み直すと行が減ることがある。開いたままの重ね枠が、もう無い行を
  // 指したままにならないよう閉じる
  useEffect(() => {
    setBulkMerge(false);
    setOverlay(null);
    setFocus(null);
    setPicking(null);
    setCoverDraft(undefined);
    setHistory([]);
    setSelection([]);
    setZoomed(null);
  }, [reloadKey]);

  const margin = useMarginJob({
    client,
    archive,
    active: active && chosen === "trim",
    generation: reloadKey,
    onSaved: () => {
      setReviewed(true);
      onArchiveChanged?.();
      refresh();
    },
  });
  const busy = splitBusy || margin.busy || restoring;
  useEffect(() => {
    if (rows && chosen === "split" && !initialSplitSelection.current) {
      initialSplitSelection.current = true;
      editRows(
        rows.map((row) =>
          !row.mergeNext && isSplitTarget(row) && !row.checked
            ? splitRow(row)
            : row,
        ),
      );
    }
  }, [rows, chosen, editRows]);

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
    if (chosen === "trim") {
      margin.undo();
      return;
    }
    const previous = history.at(-1);
    if (!previous || busy) return;
    editRows(previous.rows);
    setCoverDraft(previous.cover);
    setBulkMerge(previous.bulkMerge);
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

  const step = chosen === "trim" ? "split" : chosen;
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
    .map((row, index) =>
      !isAbsorbed(rows, index) && isSplitTarget(row) ? index : -1,
    )
    .filter((index) => index >= 0);
  const mergeTargets = rows
    .map((_, index) => (isMergeTarget(rows, index) ? index : -1))
    .filter((index) => index >= 0);
  const targets = step === "split" ? splitTargets : mergeTargets;
  const canSplitAll = splitTargets.some((index) => !rows[index].stored.checked);
  const allMergeRows = pairAllPages(rows);

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
  const edit = (next: SplitRow[], allMerges = false) => {
    if (busy) return;
    setModeNotice("");
    if (chosen !== "trim") setChosen(step);
    setHistory((past) =>
      [...past, { rows, cover: coverDraft, bulkMerge }].slice(-100),
    );
    setBulkMerge(allMerges);
    setPicking(null);
    editRows(next);
  };
  const toggleMergeExclusion = (name: string) => {
    const index = rows.findIndex((row) => row.names.includes(name));
    let next = replaceRow(rows, index, {
      mergeNext: false,
      checked: rows[index].stored.checked ? true : rows[index].checked,
    });
    if (index > 0 && next[index - 1].mergeNext)
      next = replaceRow(next, index - 1, { mergeNext: false });
    next = separatePages(next).map((row) =>
      row.names.includes(name)
        ? { ...row, mergeExcluded: !row.mergeExcluded }
        : row,
    );
    edit(bulkMerge ? pairAllPages(next) : next, bulkMerge);
  };
  const select = (name: string, event: MouseEvent) => {
    const names = rows
      .filter((row) => !row.deleted)
      .flatMap((row) => row.names);
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
  const requestStep = (next: Step | "trim") => {
    if (busy) return;
    if (next === "trim" && pending) {
      setModeNotice("余白カットの前に、編集中の変更を反映してください。");
      return;
    }
    setModeNotice("");
    setChosen(next);
    setSelection([]);
    setFocus(null);
    setPicking(null);
  };
  const save = async () => {
    setModeNotice("");
    if (await confirm(coverDraft)) {
      setReviewed(true);
    }
  };

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
    .map((row, index) =>
      !isAbsorbed(rows, index) && isCandidate(row) ? index : -1,
    )
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
  const toggleTarget = (index: number) => {
    const row = rows[index];
    if (step === "split") {
      if (row.stored.checked) return;
      edit(rows.map((item, at) => (at === index ? splitRow(item) : item)));
    } else if (row.mergeNext || isMergeCandidate(rows, index)) {
      setMerge(index, !row.mergeNext);
    } else if (row.names.length === 2) {
      setChecked(index, !row.checked);
    }
  };

  /**
   * 指したカードでのキー操作。Enter で切り替えて次の対象へ進む。← → で前後の
   * 対象へ送る。カードの中のボタンや線を掴んでいるときは、その部品の操作を
   * 優先する
   */
  const onCardKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const card = event.target as HTMLElement;
    if (!card.hasAttribute("tabindex") || busy || chosen === "trim") return;
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

  const pictureOf = (row: SplitRow, boxWidth = columnWidth) => ({
    imageUrl:
      row.source === "original"
        ? imageUrlOf(row)
        : `${client.thumbnailUrl(
            archive,
            row.names[0],
            Math.ceil(
              fitInside(row, { width: boxWidth, height: pictureHeight }).width *
                window.devicePixelRatio,
            ),
          )}&v=${reloadKey}`,
    width: row.width,
    height: row.height,
  });

  /**
   * 割った対の半分の絵。寸法は割った位置から見積もる（先に読む右半分は
   * x から右、後の左半分は x まで）
   */
  const halfOf = (row: SplitRow, part: 0 | 1) => ({
    imageUrl: `${client.thumbnailUrl(archive, row.names[part], Math.ceil(columnWidth * window.devicePixelRatio))}&v=${reloadKey}`,
    width: part === 0 ? row.width - row.x : row.x,
    height: row.height,
  });

  // 確定した編集状態は各モード共通。未確定の結合候補は結合モードだけでまとめる。
  const manualUnits = pageUnits(rows, false);
  const units = (
    chosen !== "trim" && step === "merge" && picking === null
      ? pageUnits(rows, !bulkMerge)
      : manualUnits
  ).filter((unit) => showDeleted || !rows[unit.row].deleted);
  const pageGroups = units.map((unit) => {
    const row = rows[unit.row];
    if (unit.part !== undefined) return [row.names[unit.part]];
    return unit.via === "merge"
      ? [...row.names, ...rows[unit.row + 1].names]
      : row.names;
  });
  const pickedUnit = units.find((unit) => unit.key === picking) ?? null;
  const pickable = pickedUnit ? partnersOf(rows, units, pickedUnit) : [];
  const roleOf = (unit: PageUnit): PickRole =>
    pickedUnit === null
      ? "none"
      : unit.key === pickedUnit.key
        ? "self"
        : pickable.includes(unit.key)
          ? "partner"
          : "dimmed";

  const opened = overlay === null ? null : (rows[overlay] ?? null);
  const openedUnit = units.find((unit) => unit.row === overlay);
  const openedPartner =
    openedUnit?.via === "merge" && openedUnit.part === undefined
      ? rows[openedUnit.row + 1]
      : undefined;

  const renderPage = (unit: PageUnit) => {
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
    const boxWidth = span ? columnWidth * 2 + GRID_GAP : columnWidth;
    // 保存後の見開きも、描画する幅に合う解像度で取得する。
    const pagePicture =
      unit.part !== undefined
        ? halfOf(row, unit.part)
        : pictureOf(row, partner ? columnWidth : boxWidth);
    const partnerPicture = partner ? pictureOf(partner) : undefined;
    const label = row.deleted
      ? "削除済み"
      : unit.part !== undefined
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
        cover={
          !row.deleted &&
          index ===
            rows.findIndex(
              (item, at) => !item.deleted && !isAbsorbed(rows, at),
            ) &&
          (unit.part ?? 0) === 0
        }
        deleted={row.deleted}
        displayName={row.deleted ? `削除したページ ${index + 1}` : undefined}
        canDelete={row.deleted || unit.part === undefined || !isPending(row)}
        deleteLabel={
          unit.kind === "candidate"
            ? "2 ページを削除（復元可能）"
            : "ページを削除（復元可能）"
        }
        onDelete={() => {
          const names =
            unit.part !== undefined
              ? [row.names[unit.part]]
              : merging
                ? [...row.names, ...rows[index + 1].names]
                : row.names;
          const next = unit.part !== undefined ? separatePages(rows) : rows;
          edit(
            next.map((item) =>
              item.names.some((name) => names.includes(name))
                ? { ...item, deleted: !row.deleted }
                : item,
            ),
          );
          if (coverDraft && names.includes(coverDraft.name))
            setCoverDraft(undefined);
          setSelection([]);
          setOverlay(null);
          setFocus(null);
        }}
        disabled={busy}
        selected={selection.includes(row.names[unit.part ?? 0])}
        onSelect={(event) => select(row.names[unit.part ?? 0], event)}
        onZoom={() =>
          chosen !== "trim" && step === "split" && !row.deleted
            ? setOverlay(index)
            : setZoomed(row.names[unit.part ?? 0])
        }
        zoomLabel={`${label} ページを大きく表示`}
        canCover={!row.deleted && !isPending(row) && !isAbsorbed(rows, index)}
        onCover={() => chooseCover(row.names[unit.part ?? 0])}
        onAdjust={() => setAdjusting(row.names[unit.part ?? 0])}
        mergePages={
          chosen === "merge" && !row.deleted
            ? (unit.part !== undefined
                ? [row.names[unit.part]]
                : partner
                  ? [...row.names, ...partner.names]
                  : row.names
              ).map((name) => ({
                name,
                excluded:
                  rows.find((item) => item.names.includes(name))
                    ?.mergeExcluded === true,
                cover: name === rows.find((item) => !item.deleted)?.names[0],
              }))
            : undefined
        }
        onMergeExclude={toggleMergeExclusion}
      >
        <div
          inert={
            busy ||
            row.deleted ||
            coverDraft?.name === row.names[unit.part ?? 0]
          }
          className={
            row.deleted || coverDraft?.name === row.names[unit.part ?? 0]
              ? "pointer-events-none opacity-70"
              : undefined
          }
        >
          {chosen === "trim" ? (
            <MarginCard
              index={index}
              part={unit.part}
              label={label}
              span={span}
              boxWidth={boxWidth}
              boxHeight={pictureHeight}
              page={pagePicture}
              margins={margin.margins}
              checked={margin.selected.includes(row.names[unit.part ?? 0])}
              disabled={
                busy ||
                row.deleted ||
                !margin.scan?.pages.some(
                  (page) => page.name === row.names[unit.part ?? 0],
                )
              }
              onToggle={() => {
                const name = row.names[unit.part ?? 0];
                margin.setSelected(
                  margin.selected.includes(name)
                    ? margin.selected.filter((item) => item !== name)
                    : [...margin.selected, name],
                );
              }}
              onZoom={() => setZoomed(row.names[unit.part ?? 0])}
            />
          ) : step === "split" ? (
            <SplitCard
              index={index}
              part={unit.part}
              label={label}
              actionLabel={numberLabel(numbers[index])}
              pending={isPending(row)}
              applied={row.stored.checked && row.checked}
              focused={focus === index && unit.part === undefined}
              checked={row.checked}
              target={isSplitTarget(row)}
              keptWhole={row.keptWhole}
              wide={wide}
              span={span}
              boxWidth={boxWidth}
              boxHeight={pictureHeight}
              page={pagePicture}
              partner={partnerPicture}
              joined={row.mergeNext || (row.stored.checked && !row.checked)}
              x={row.x}
              onToggle={() => toggleTarget(index)}
              onMoveSplit={(x) => setSplit(index, x)}
              onZoom={() => setOverlay(index)}
            />
          ) : (
            <MergeCard
              key={unit.key}
              index={index}
              part={unit.part}
              label={label}
              pending={isPending(row)}
              focused={focus === index && unit.part === undefined}
              kind={unit.kind}
              span={span}
              boxWidth={boxWidth}
              boxHeight={pictureHeight}
              page={pagePicture}
              partner={partnerPicture}
              seamX={unit.via === "rejoin" ? row.x : undefined}
              pick={role}
              onMerge={
                unit.kind === "candidate"
                  ? () => toggleTarget(index)
                  : undefined
              }
              onCancelMerge={
                unit.kind === "joined" && merging
                  ? () => setMerge(index, false)
                  : unit.kind === "joined"
                    ? () => setChecked(index, true)
                    : undefined
              }
              onPick={
                partnersOf(rows, manualUnits, unit).length > 0
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
          )}
        </div>
      </EditablePage>
    );
  };

  let marginResult = "余白の検出を開始しています…";
  if (margin.error) marginResult = margin.message;
  else if (margin.busy) marginResult = "余白カットを処理しています…";
  else if (margin.needsDetection)
    marginResult =
      "画像が変わりました。再検出するか切り取り量を確認してください。";
  else if (margin.scan) {
    const detected = margin.scan.margins.some((value) => value > 0);
    if (margin.margins.some((value) => value > 0)) {
      const amounts = margin.margins
        .map((value, index) => `${["左", "上", "右", "下"][index]} ${value}%`)
        .join(" / ");
      marginResult = `${detected ? "余白を検出" : "手動の切り取り量"} · ${amounts} · 枠を確認して反映`;
    } else {
      marginResult = `${detected ? "切り取り量は0%です" : "共通余白なし"} · 「切り取り量を調整」から指定できます`;
    }
  }

  const modes = (
    <Segmented<Step | "trim">
      disabled={busy}
      items={[
        {
          id: "trim",
          label: "余白カット",
          testId: "split-step-trim",
          description:
            "共通余白を提案します。全ページから不要な対象を外し、枠を確認して反映します。",
        },
        {
          id: "split",
          label: <StepLabel text="ページを分割" count={splitTargets.length} />,
          testId: "split-step-split",
          description:
            "分割できるページを最初に選択します。不要な対象を外し、分割線を確認して右上から反映します。",
        },
        {
          id: "merge",
          label: <StepLabel text="ページを結合" count={mergeTargets.length} />,
          testId: "split-step-merge",
          description:
            "全選択はサムネイルを除いて隣同士をペアにします。右クリックで対象外にできます。右上の変更を反映を押すまで保存しません。",
        },
      ]}
      value={chosen === "trim" ? "trim" : step}
      onChange={requestStep}
    />
  );

  return (
    <EditorLayout
      toolbar={
        <>
          <span className="shrink-0 text-[11px] text-ink-faint">
            モード選択
          </span>
          {modes}
          <EditorSelection
            disabled={busy}
            allDisabled={
              chosen === "trim"
                ? !margin.scan
                : step === "split"
                  ? !canSplitAll
                  : !allMergeRows.some((row) => row.mergeNext)
            }
            allTestId={
              chosen === "trim"
                ? "margin-select-all"
                : step === "split"
                  ? "split-all"
                  : "merge-all"
            }
            onAll={() => {
              setModeNotice("");
              if (chosen === "trim")
                margin.setSelected(
                  margin.scan?.pages.map((page) => page.name) ?? [],
                );
              else if (step === "split") edit(splitAll(rows));
              else edit(allMergeRows, true);
            }}
            onDetected={() => {
              setModeNotice("");
              if (chosen === "trim")
                margin.setSelected(
                  margin.scan?.pages
                    .filter((page) => page.margins.some((value) => value > 0))
                    .map((page) => page.name) ?? [],
                );
              else if (step === "split")
                edit(
                  rows.map((row) =>
                    row.stored.checked
                      ? row
                      : { ...row, checked: !row.deleted && row.detected },
                  ),
                );
              else
                edit(
                  mergeAll(
                    rows.map((row) => ({
                      ...row,
                      mergeNext: false,
                      checked: row.stored.checked ? true : row.checked,
                    })),
                  ),
                );
            }}
            onClear={() => {
              setModeNotice("");
              if (chosen === "trim") margin.setSelected([]);
              else if (step === "split")
                edit(
                  rows.map((row) =>
                    row.stored.checked
                      ? row
                      : { ...row, checked: false, x: row.stored.x },
                  ),
                );
              else
                edit(
                  rows.map((row) => ({
                    ...row,
                    mergeNext: false,
                    checked: row.stored.checked ? true : row.checked,
                  })),
                );
            }}
          />
          {chosen === "trim" ? (
            <>
              <MarginControls job={margin} />
              <Button
                variant="secondary"
                disabled={busy}
                onClick={margin.rescan}
              >
                再検出
              </Button>
            </>
          ) : (
            <>
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
            </>
          )}
          <div className="flex-1" />
          {chosen === "trim" && !pending ? (
            <Button
              variant="primary"
              size="lg"
              className="shrink-0"
              data-testid="margin-save"
              disabled={busy || !margin.canSave}
              onClick={() => void margin.save()}
            >
              <Save />
              余白カットを反映
            </Button>
          ) : (
            <>
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
          )}
        </>
      }
      hint={
        <span className="flex h-7 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            data-testid="undo"
            title="直前の編集を元に戻す（Ctrl+Z）"
            aria-label="直前の編集を元に戻す"
            disabled={
              busy ||
              (chosen === "trim"
                ? margin.history.length === 0
                : history.length === 0)
            }
            onClick={undo}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            data-testid="split-reset"
            title="未保存の変更をすべて破棄"
            aria-label="未保存の変更をすべて破棄"
            disabled={busy || (!pending && chosen !== "trim")}
            onClick={() => {
              if (chosen === "trim") margin.discard();
              setPicking(null);
              restore();
              setHistory([]);
              setBulkMerge(false);
              setSelection([]);
              setCoverDraft(undefined);
            }}
          >
            <RotateCcw />
          </Button>
          <select
            aria-label="保存済み編集の復元"
            disabled={busy}
            value=""
            onChange={(event) =>
              setRestoreMode(
                event.target.value as
                  "all" | "trim" | "split" | "merge" | "thumbnail",
              )
            }
            className="h-7 rounded border border-line bg-surface px-2 text-xs"
          >
            <option value="" disabled>
              保存済み編集を復元…
            </option>
            <option value={chosen}>このモードの加工を戻す</option>
            <option value="thumbnail">サムネイルの画像加工を戻す</option>
            <option value="all">本全体の編集を戻す</option>
          </select>
          {chosen === "merge" ? (
            <span
              data-testid="merge-selection-hint"
              className="shrink-0 text-ink-muted"
              title="全選択はサムネイルを除いて隣同士をペアにします。右クリックでページを対象外にすると、その後ろからペアを組み直します。"
            >
              右クリックで結合対象外にできます
            </span>
          ) : null}
          <span
            className="min-w-0 flex-1 truncate"
            role="status"
            data-testid="split-status"
            data-state={report.state}
            title={chosen === "trim" ? margin.message : status}
          >
            {modeNotice ||
              (chosen === "trim" ? (
                <span data-testid="margin-result">{marginResult}</span>
              ) : (
                status
              ))}
          </span>
          <label className="flex shrink-0 items-center gap-1.5">
            <input
              type="checkbox"
              data-testid="show-deleted-pages"
              checked={showDeleted}
              onChange={(event) =>
                setDeletedVisibility(String(event.target.checked))
              }
            />
            削除したページも表示
          </label>
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
      {restoreMode ? (
        <EditRestoreDialog
          client={client}
          archive={archive}
          mode={restoreMode}
          onClose={() => setRestoreMode(null)}
          onBusy={setRestoring}
          onRestored={(result) => {
            setReviewed(false);
            setModeNotice(
              result.complete
                ? "編集前の本に戻しました"
                : "復元できる加工を戻しました。記録のない編集は維持しています。",
            );
            onArchiveChanged?.();
            refresh();
          }}
        />
      ) : null}
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        aria-busy={chosen === "trim" && margin.busy}
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
                {columnWidth > 0 ? units.map(renderPage) : null}
              </div>
            </div>
          </SortableContext>
        </DndContext>
        {chosen === "trim" ? <MarginProgress job={margin} /> : null}
      </div>

      {zoomed ? (
        <Dialog open onOpenChange={() => setZoomed(null)}>
          <DialogContent
            data-testid="lightbox"
            className="flex h-[90vh] w-[94vw] max-w-none! flex-col items-center"
            aria-describedby={undefined}
          >
            <DialogTitle>
              {rows.find((row) => row.names.includes(zoomed))?.deleted
                ? "削除したページ"
                : zoomed}
              （Esc で閉じる）
            </DialogTitle>
            {chosen === "trim" ? (
              <div className="relative min-h-0 mx-auto">
                <img
                  data-testid="lightbox-image"
                  src={`${client.imageUrl(archive, zoomed)}&v=${reloadKey}`}
                  alt={zoomed}
                  className="block max-h-[78vh] max-w-[88vw] object-contain"
                />
                <MarginFrame margins={margin.margins} />
              </div>
            ) : (
              <img
                data-testid="lightbox-image"
                className="min-h-0 flex-1 object-contain"
                src={`${client.imageUrl(archive, zoomed)}&v=${reloadKey}`}
                alt={zoomed}
              />
            )}
          </DialogContent>
        </Dialog>
      ) : null}

      {step === "split" && opened !== null && overlay !== null ? (
        <SplitDialog
          label={numberLabel(numbers[overlay])}
          numbers={numbers[overlay]}
          checked={opened.checked}
          saved={opened.stored.checked}
          x={opened.x}
          width={opened.width}
          height={opened.height}
          imageUrl={imageUrlOf(opened)}
          partner={
            openedPartner
              ? {
                  ...pictureOf(openedPartner),
                  imageUrl: imageUrlOf(openedPartner),
                }
              : undefined
          }
          onToggle={() => {
            toggleTarget(overlay);
            if (opened.mergeNext) setOverlay(null);
          }}
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
