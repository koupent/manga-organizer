import {
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Save,
  Undo2,
} from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { SidecarClient } from "../api/client";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";
import { EditorLayout } from "./EditorLayout";
import { SplitCard } from "./SplitCard";
import { SplitDialog } from "./SplitDialog";
import { useStoredNumber } from "../lib/setting";
import { useSplitJob } from "../lib/split-job";
import { useBoxSize } from "../lib/stage";
import { cn } from "../lib/utils";
import {
  acceptedAll,
  answeredRows,
  canMergeNext,
  isCandidate,
  isPending,
  isWide,
  numberLabel,
  pageNumbers,
  proposalOf,
  replaceRow,
  summaryOf,
  type Answer,
  type SplitRow,
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

type SplitEditorProps = {
  client: SidecarClient;
  archive: string;
  /** アーカイブを書き換えたことを伝える。他の画面が持つページは古くなる */
  onArchiveChanged?: () => void;
};

/**
 * ページ分割・結合の画面（#58 段階 3、#139）。
 *
 * 横長 1 枚に入った見開きを 2 ページへ割る。隣り合う単ページ 2 枚を 1 枚の
 * 見開きへ結合することもできる。**利用者に見せるのは「その見開きが
 * 何ページ目になるか」だけ**で、割る前の画像と割った半分の区別は最後まで出さない。
 * 一度割った本を開き直しても、その対は 1 枚の見開きとしていまの分割位置とともに
 * 現れ、線を動かす・割る前へ戻すがそのまま続けられる。
 *
 * 変更はすべて保留にし、確定したときに 1 回だけ書き込む。押すたびに書き込む
 * 作りでは、位置を直すたびに割り直した半分がさらに割られる。
 *
 * ページは 1 枚ずつそのまま並べ、横長には分割を、端の色がつながる 2 枚には
 * 結合を提案する（#151）。提案は同じ形の札で示し、「採用」「このまま」で
 * 答える。まとめて採用することも、キーで 1 件ずつ答えることもできる。
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

  const [overlay, setOverlay] = useState<number | null>(null);
  // 前後の提案へ送るボタンで指している行（#131 #151）。数百ページの本で、
  // 提案を探して格子をスクロールさせずに済むようにする。絞り込まないのは、
  // 前後のページとのつながりが見えなくなるため
  const [focus, setFocus] = useState<number | null>(null);
  const [cardWidth, setCardWidth] = useStoredNumber(
    CARD_WIDTH_KEY,
    CARD_WIDTH_DEFAULT,
  );
  // 列の幅は auto-fill が決める。実測してから絵の箱の寸法を導く
  const [gridRef, gridSize] = useBoxSize<HTMLDivElement>();

  // 読み直すと行が減ることがある。開いたままの重ね枠が、もう無い行を
  // 指したままにならないよう閉じる
  useEffect(() => {
    setOverlay(null);
    setFocus(null);
  }, [reloadKey]);

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

  const numbers = pageNumbers(rows);
  // 分割・結合の提案（#151）。答えても提案の有無は変わらないので、送りの
  // 並びは開いている間ずっと同じ
  const proposals = rows.map((_, index) => proposalOf(rows, index));
  const splitCount = proposals.filter((item) => item?.kind === "split").length;
  const mergeCount = proposals.filter((item) => item?.kind === "merge").length;
  const openCount = proposals.filter((item) => item?.state === "open").length;
  const proposalText =
    splitCount + mergeCount === 0
      ? "提案はありません"
      : [
          splitCount > 0 ? `分割 ${splitCount}` : "",
          mergeCount > 0 ? `結合 ${mergeCount}` : "",
        ]
          .filter(Boolean)
          .join("・") + " の提案";
  const pending = rows.some(isPending);
  const status = report.state === "idle" ? summaryOf(rows) : report.message;

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

  // 手で切り替えたら、その行の提案への「このまま」は取り消す
  const setChecked = (index: number, checked: boolean) =>
    editRows(replaceRow(rows, index, { checked, declined: false }));

  const setSplit = (index: number, x: number) =>
    editRows(replaceRow(rows, index, { x }));

  const setMerge = (index: number, mergeNext: boolean) =>
    editRows(replaceRow(rows, index, { mergeNext, declined: false }));

  const answer = (index: number, choice: Answer) =>
    editRows(answeredRows(rows, index, choice));

  /** 行の番号のうち、条件に合うものだけ */
  const indicesWhere = (accept: (index: number) => boolean) =>
    rows.map((_, index) => index).filter(accept);
  // 拡大表示は 1 枚を割る道具なので、そこで辿るのは分割の候補だけ。見出しの
  // 送りボタンは提案（#151）を辿る
  const candidates = indicesWhere((index) => isCandidate(rows[index]));
  const targets = indicesWhere((index) => proposals[index] !== null);

  /**
   * 結合した後の姿で描く行か。結合する行と、結合を提案している（まだ答えて
   * いない）行。次の行はこのカードに吸い込まれて格子から消える
   */
  const joined = (index: number) =>
    rows[index]?.mergeNext === true ||
    (proposals[index]?.kind === "merge" && proposals[index]?.state === "open");

  /**
   * from の行から見て、前（-1）・次（+1）にある最初の候補。無ければ undefined。
   *
   * 選ぶのは「from より後ろ／前にある最初の候補」で、候補の並びの中での位置では
   * ない。候補でない行からも拡大表示は開くので、その行が候補の並びに居ないことを
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
   * 前後の提案を指し、格子の中央まで送る。カードへフォーカスも移すので、
   * そのまま Enter・Backspace で答えられる
   */
  const step = (target: number | undefined) => {
    if (target === undefined) return;
    setFocus(target);
    const card = document.querySelector<HTMLElement>(
      `[data-testid="split-card"][data-index="${target}"]`,
    );
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const focusedAt = focus === null ? -1 : targets.indexOf(focus);

  /**
   * 指したカードでのキー操作（#151）。Enter で採用、Backspace で「このまま」と
   * 答えて次の提案へ進む。← → で前後の提案へ送る。カードの中のボタンや
   * 線を掴んでいるときは、その部品の操作を優先する
   */
  const onCardKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const card = event.target as HTMLElement;
    if (card.dataset.testid !== "split-card" || busy) return;
    const index = Number(card.dataset.index);
    if (event.key === "Enter" || event.key === "Backspace") {
      if (proposals[index] === null) return;
      event.preventDefault();
      answer(index, event.key === "Enter" ? "accept" : "decline");
      step(candidateFrom(targets, index, 1));
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      step(candidateFrom(targets, index, event.key === "ArrowRight" ? 1 : -1));
    }
  };

  const imageUrlOf = (row: SplitRow) =>
    `${
      row.source === "original"
        ? client.originalUrl(archive, row.names[0])
        : client.imageUrl(archive, row.names[0])
    }&v=${reloadKey}`;

  const opened = overlay === null ? null : (rows[overlay] ?? null);

  return (
    <EditorLayout
      toolbar={
        <>
          <span
            className="tabular shrink-0 text-[12px] text-ink-faint"
            data-testid="split-page-count"
          >
            {pageCount} ページ
          </span>
          {/* 提案の入口（#151）。開いた時点では何も採用しないので、ここか
              カードの「採用」が分割・結合の始まりになる */}
          <span
            className="tabular shrink-0 text-[12px] text-ink-muted"
            data-testid="split-proposals"
          >
            {proposalText}
          </span>
          <Button
            variant="secondary"
            className="shrink-0"
            data-testid="split-accept-all"
            title="まだ答えていない提案を、すべて採用する"
            disabled={openCount === 0 || busy}
            onClick={() => editRows(acceptedAll(rows))}
          >
            <CheckCheck />
            すべて採用
          </Button>
          <span className="flex shrink-0 items-center gap-1">
            <Button
              variant="secondary"
              size="icon"
              className="size-7"
              data-testid="split-previous"
              title="前の提案を指す"
              aria-label="前の提案を指す"
              disabled={previous === undefined}
              onClick={() => step(previous)}
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
              title="次の提案を指す"
              aria-label="次の提案を指す"
              disabled={following === undefined}
              onClick={() => step(following)}
            >
              <ChevronRight />
            </Button>
          </span>
          {/* 見出しの文字は置かない。提案の操作でツールバーが詰まり、状態欄の
              文が切れるため（#151） */}
          <label className="flex shrink-0 items-center" title="表示サイズ">
            <input
              type="range"
              aria-label="表示サイズ"
              min={CARD_WIDTH_MIN}
              max={CARD_WIDTH_MAX}
              step={CARD_WIDTH_STEP}
              value={cardWidth}
              data-testid="split-card-width"
              onChange={(event) => setCardWidth(Number(event.target.value))}
              className="h-1 w-28 cursor-pointer accent-brand"
            />
          </label>
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
            variant="secondary"
            className="shrink-0"
            data-testid="split-reset"
            title="提案への答え・チェック・分割位置を開いたときの状態に戻す"
            disabled={!pending || busy}
            onClick={restore}
          >
            <Undo2 />
            変更を戻す
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
            onClick={confirm}
          >
            <Save />
            この内容で保存する
          </Button>
        </>
      }
      hint="提案は「採用」で反映、「このまま」で見送り ・ ‹ › で提案を指し、Enter で採用・Backspace でこのまま ・ 提案に無い分割・結合はカードを指すと出ます ・ 線を掴んで分割位置を動かす ・ 画像をクリックで大きく表示"
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
            ? rows.map((row, index) => {
                // 結合される（結合を提案されている）行は、吸い込んだ行の
                // カードに一緒に描く（#139 #151）
                if (index > 0 && joined(index - 1)) return null;
                const partner = joined(index) ? rows[index + 1] : null;
                const wide = isWide(row) || partner !== null;
                const span = wide && columns >= 2;
                // 結合を提案しているだけの 2 枚は、まだ 2 ページのまま
                const label =
                  partner && !row.mergeNext
                    ? numberLabel([numbers[index][0], numbers[index + 1][0]])
                    : numberLabel(numbers[index]);
                return (
                  <SplitCard
                    key={index}
                    index={index}
                    label={label}
                    pending={isPending(row)}
                    applied={row.stored.checked && row.checked}
                    focused={focus === index}
                    checked={row.checked}
                    proposal={proposals[index]}
                    keptWhole={row.keptWhole}
                    wide={wide}
                    span={span}
                    boxWidth={span ? columnWidth * 2 + GRID_GAP : columnWidth}
                    boxHeight={pictureHeight}
                    width={row.width}
                    height={row.height}
                    x={row.x}
                    imageUrl={imageUrlOf(row)}
                    partner={
                      partner
                        ? {
                            imageUrl: imageUrlOf(partner),
                            width: partner.width,
                            height: partner.height,
                          }
                        : undefined
                    }
                    onMergeNext={
                      row.mergeNext || canMergeNext(rows, index)
                        ? () => setMerge(index, !row.mergeNext)
                        : undefined
                    }
                    onAnswer={(choice) => answer(index, choice)}
                    onToggle={() => setChecked(index, !row.checked)}
                    onMoveSplit={(x) => setSplit(index, x)}
                    onZoom={() => setOverlay(index)}
                  />
                );
              })
            : null}
        </div>
      </div>

      {opened !== null && overlay !== null ? (
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
    </EditorLayout>
  );
}
