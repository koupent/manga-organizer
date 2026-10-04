import {
  ChevronLeft,
  ChevronRight,
  Link2,
  Loader2,
  Save,
  Scissors,
  Undo2,
} from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { SidecarClient } from "../api/client";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Empty } from "./ui/empty";
import { Segmented } from "./ui/segmented";
import { EditorLayout } from "./EditorLayout";
import { MergeCard, type PickRole } from "./MergeCard";
import { SplitCard } from "./SplitCard";
import { SplitDialog } from "./SplitDialog";
import { useStoredNumber } from "../lib/setting";
import { useSplitJob } from "../lib/split-job";
import { useBoxSize } from "../lib/stage";
import { cn } from "../lib/utils";
import {
  canUnmerge,
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
  unmergeAll,
  type MergeUnit,
  type SplitRow,
  type Step,
} from "../lib/split";

/**
 * 表示サイズ（カード 1 枚の最小幅・px）の可動域と既定。
 *
 * ページ並べ替えと同じ値にする。同じ本を同じ大きさで見比べる作業なので、
 * 画面を移った途端に密度が変わると、どのページを見ていたか分からなくなる。
 */
const CARD_WIDTH_MIN = 140;
const CARD_WIDTH_MAX = 520;
const CARD_WIDTH_STEP = 20;
const CARD_WIDTH_DEFAULT = 160;

/** 表示サイズの保存先。並べ替えとは別に覚える */
const CARD_WIDTH_KEY = "split.cardWidth";

/** 格子の隙間（gap-3）。列の幅を出すのに要る */
const GRID_GAP = 12;

/** 絵の箱の高さ／列の幅。縦長ページ（2:3）がちょうど収まる比 */
const PICTURE_RATIO = 1.5;

/** ステップごとの説明。見出しの下に 1 行で出す */
const GUIDES: Record<Step, string> = {
  split:
    "横長のページを 2 ページに分けます ・ 線を掴むと分ける位置を動かせます ・ 画像をクリックで大きく表示",
  merge:
    "端の絵がつながる 2 ページを候補にしています ・ 候補に無い 2 ページは「結合…」を押してから相手を押す ・ ✂ で見開きを解く",
};

type SplitEditorProps = {
  client: SidecarClient;
  archive: string;
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

/**
 * ページ分割・結合の画面（#58 段階 3、#139、#153）。
 *
 * 作業を 2 つのステップに分ける。①で全ページを単ページにし（横長を分ける）、
 * ②で見開きで見たいものを結合する。画面にはいまのステップの操作だけを出す。
 *
 * **利用者に見せるのは「そのページが何ページ目になるか」だけ**で、割る前の
 * 画像と割った半分の区別は最後まで出さない。
 *
 * 変更はすべて保留にし、保存したときに 1 回だけ書き込む。押すたびに書き込む
 * 作りでは、位置を直すたびに割り直した半分がさらに割られる。②の候補は①の
 * 分割を本に書いた後でないと判定できないので、保存していない変更があるまま
 * ステップを切り替えるときは確かめる。
 */
export function SplitEditor({
  client,
  archive,
  onArchiveChanged,
}: SplitEditorProps) {
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
  } = useSplitJob({ client, archive, onArchiveChanged });

  // 利用者が選んだステップ。選ぶまでは、開いた本の中身から決める（firstStep）
  const [chosen, setChosen] = useState<Step | null>(null);
  // 保存していない変更があるまま切り替えようとした先。確認の枠を出す
  const [switchTo, setSwitchTo] = useState<Step | null>(null);
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
  const pending = rows.some(isPending);
  const status = report.state === "idle" ? summaryOf(rows) : report.message;

  // ステップごとの対象。送りボタンはこれを辿る。件数は本に書かれている状態で
  // 数えるので、選んでも減らない
  const splitTargets = rows
    .map((row, index) => (isSplitTarget(row) ? index : -1))
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
  const canUnmergeAll = rows.some(canUnmerge);

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
    setPicking(null);
    editRows(next);
  };

  const setChecked = (index: number, checked: boolean) =>
    edit(replaceRow(rows, index, { checked }));

  const setSplit = (index: number, x: number) =>
    edit(replaceRow(rows, index, { x }));

  const setMerge = (index: number, mergeNext: boolean) =>
    edit(replaceRow(rows, index, { mergeNext }));

  /**
   * ステップを移る。保存していない変更があれば、先に確かめる。書き込みと
   * 読み直しの最中は移らない。並んでいるのはまだ書き込む前の行で、保留に
   * 見えてしまう
   */
  const requestStep = (next: Step) => {
    if (next === step || busy) return;
    if (pending) {
      setSwitchTo(next);
      return;
    }
    setChosen(next);
    setFocus(null);
    setPicking(null);
  };

  const saveAndSwitch = async () => {
    const next = switchTo;
    setSwitchTo(null);
    if (next !== null && (await confirm())) setChosen(next);
  };

  const discardAndSwitch = () => {
    const next = switchTo;
    setSwitchTo(null);
    restore();
    if (next !== null) setChosen(next);
    setFocus(null);
    setPicking(null);
  };

  /** 保存する。①では保存できたら②へ進む */
  const save = async () => {
    if ((await confirm()) && step === "split") setChosen("merge");
  };

  // 拡大表示は 1 枚を割る道具なので、そこで辿るのは分割の候補だけ
  const candidates = rows
    .map((row, index) => (isCandidate(row) ? index : -1))
    .filter((index) => index >= 0);

  /**
   * from の行から見て、前（-1）・次（+1）にある最初の対象。無ければ undefined。
   *
   * 選ぶのは「from より後ろ／前にある最初の対象」で、対象の並びの中での位置では
   * ない。対象でない行からも拡大表示は開くので、その行が対象の並びに居ないことを
   * 勘定に入れないと、→ を押した利用者が本の先頭側へ飛ばされる。
   */
  const candidateFrom = (list: number[], from: number, delta: number) => {
    const behind = list.filter((index) => index < from);
    const ahead = list.filter((index) => index > from);
    return delta > 0 ? ahead[0] : behind[behind.length - 1];
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
    imageUrl: imageUrlOf(row),
    width: row.width,
    height: row.height,
  });

  /**
   * 割った対の半分の絵。寸法は割った位置から見積もる（先に読む右半分は
   * x から右、後の左半分は x まで）
   */
  const halfOf = (row: SplitRow, part: 0 | 1) => ({
    imageUrl: `${client.imageUrl(archive, row.names[part])}&v=${reloadKey}`,
    width: part === 0 ? row.width - row.x : row.x,
    height: row.height,
  });

  // ②の並び（#154）。割った対は 2 枚の単ページとして出す
  const units = step === "merge" ? mergeUnits(rows) : [];
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
    // ①では結合の保留は無い（切り替える前に保存か破棄をしている）。保存済みの
    // 結合は 1 枚の横長として並ぶ
    if (isAbsorbed(rows, index)) return null;
    const wide = isWide(row);
    const span = wide && columns >= 2;
    return (
      <SplitCard
        key={index}
        index={index}
        label={numberLabel(numbers[index])}
        pending={isPending(row)}
        applied={row.stored.checked && row.checked}
        focused={focus === index}
        checked={row.checked}
        target={isSplitTarget(row)}
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
        page={unit.part !== undefined ? halfOf(row, unit.part) : pictureOf(row)}
        partner={partner ? pictureOf(partner) : undefined}
        seamX={unit.via === "rejoin" ? row.x : undefined}
        cut={
          unit.kind === "spread" && row.checked
            ? { x: row.x, onMove: (x) => setSplit(index, x) }
            : undefined
        }
        pick={role}
        onMerge={
          unit.kind === "candidate" ? () => toggleTarget(index) : undefined
        }
        onUnmerge={
          unit.kind === "joined" && merging
            ? () => setMerge(index, false)
            : unit.kind === "joined" || unit.kind === "spread"
              ? () => setChecked(index, !row.checked)
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
    );
  };

  return (
    <EditorLayout
      toolbar={
        <>
          <Segmented<Step>
            items={[
              {
                id: "split",
                label: (
                  <StepLabel
                    text="① 単ページにする"
                    count={splitTargets.length}
                  />
                ),
                testId: "split-step-split",
              },
              {
                id: "merge",
                label: (
                  <StepLabel
                    text="② 見開きにする"
                    count={mergeTargets.length}
                  />
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
              title="まだ分けていない横長のページを、すべて中央で分ける"
              disabled={!canSplitAll || busy}
              onClick={() => edit(splitAll(rows))}
            >
              <Scissors />
              すべて分割
            </Button>
          ) : (
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
          )}
          {step === "merge" ? (
            <Button
              variant="ghost"
              className="shrink-0"
              data-testid="unmerge-all"
              title="見開きをすべて解く（結合をやめ、横長のページは中央で分ける）"
              disabled={!canUnmergeAll || busy}
              onClick={() => edit(unmergeAll(rows))}
            >
              <Scissors />
              すべて解く
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
            data-testid="split-reset"
            title="変更を戻す（開いたときの状態に戻す）"
            aria-label="変更を戻す"
            disabled={!pending || busy}
            onClick={() => {
              setPicking(null);
              restore();
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
            disabled={!pending || busy}
            onClick={() => void save()}
          >
            <Save />
            {step === "split" ? "保存して②へ" : "保存"}
          </Button>
        </>
      }
      hint={
        <span className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate">{GUIDES[step]}</span>
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
      <div data-testid="split-grid" className="min-h-0 flex-1 overflow-y-auto">
        {/* 行の高さは中身に合わせる（auto-rows-max）。auto のままだと、
            高さの決まった格子を行数で割った高さへ押し込められる */}
        {/* カードのキー操作はここで受ける（onCardKey） */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          ref={gridRef}
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
        open={switchTo !== null}
        onOpenChange={(open) => {
          if (!open) setSwitchTo(null);
        }}
      >
        <DialogContent
          data-testid="step-switch-dialog"
          className="w-[min(28rem,92vw)] gap-3 p-4"
        >
          <DialogTitle className="text-[14px] font-semibold">
            保存していない変更があります
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-ink-muted">
            このまま切り替えると、変更は消えます。
          </DialogDescription>
          {/* 先頭の「保存して切り替える」に最初のフォーカスが当たる。並びは
              右から左にして、主操作を右端に置く */}
          <div className="flex flex-row-reverse gap-2">
            <Button
              variant="primary"
              data-testid="step-switch-save"
              onClick={() => void saveAndSwitch()}
            >
              保存して切り替える
            </Button>
            <Button
              variant="secondary"
              data-testid="step-switch-discard"
              onClick={discardAndSwitch}
            >
              保存せずに切り替える
            </Button>
            <Button
              variant="ghost"
              data-testid="step-switch-cancel"
              onClick={() => setSwitchTo(null)}
            >
              やめる
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </EditorLayout>
  );
}
