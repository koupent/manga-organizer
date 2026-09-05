import { FolderOpen, Loader2, Scissors, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { SidecarClient } from "../api/client";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Empty } from "./ui/empty";
import { SplitCard } from "./SplitCard";
import { SplitDialog } from "./SplitDialog";
import { useStoredNumber } from "../lib/setting";
import { useSplitJob } from "../lib/split-job";
import { useBoxSize } from "../lib/stage";
import { cn } from "../lib/utils";
import {
  isCandidate,
  isPending,
  isWide,
  numberLabel,
  pageNumbers,
  replaceRow,
  summaryOf,
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
  archiveName?: string;
  /** 別のアーカイブを選び直す。渡さなければ選び直す導線を出さない */
  onChangeArchive?: () => void;
  /** アーカイブを書き換えたことを伝える。他の画面が持つページは古くなる */
  onArchiveChanged?: () => void;
};

/**
 * ページ分割の画面（#58 段階 3）。
 *
 * 横長 1 枚に入った見開きを 2 ページへ割る。**利用者に見せるのは「その見開きが
 * 何ページ目になるか」だけ**で、割る前の画像と割った半分の区別は最後まで出さない。
 * 一度割った本を開き直しても、その対は 1 枚の見開きとしていまの分割位置とともに
 * 現れ、線を動かす・割る前へ戻すがそのまま続けられる。
 *
 * 変更はすべて保留にし、確定したときに 1 回だけ書き込む。押すたびに書き込む
 * 作りでは、位置を直すたびに割り直した半分がさらに割られる。
 */
export function SplitEditor({
  client,
  archive,
  archiveName,
  onChangeArchive,
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
  const detected = rows.filter((row) => row.detected);
  const chosen = detected.filter((row) => row.checked).length;
  const master =
    chosen === 0 ? false : chosen === detected.length ? true : "indeterminate";
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

  const setChecked = (index: number, checked: boolean) =>
    editRows(replaceRow(rows, index, { checked }));

  const setSplit = (index: number, x: number) =>
    editRows(replaceRow(rows, index, { x }));

  /** 判定した行をまとめて選ぶ・外す */
  const toggleAll = () => {
    const turnOn = chosen < detected.length;
    editRows(
      rows.map((row) => (row.detected ? { ...row, checked: turnOn } : row)),
    );
  };

  /** 分割の対象になりうる行だけを、前後に辿れるようにする */
  const candidates = rows
    .map((row, index) => (isCandidate(row) ? index : -1))
    .filter((index) => index >= 0);

  /**
   * 前後の候補へ移る。-1 が前、+1 が次。
   *
   * 選ぶのは「開いている行より後ろ／前にある最初の候補」で、候補の並びの中での
   * 位置ではない。候補でない行からも拡大表示は開くので、その行が候補の並びに
   * 居ないことを勘定に入れないと、→ を押した利用者が本の先頭側へ飛ばされる。
   */
  const walk = (delta: number) => {
    if (overlay === null) return;
    const behind = candidates.filter((index) => index < overlay);
    const ahead = candidates.filter((index) => index > overlay);
    const next = delta > 0 ? ahead[0] : behind[behind.length - 1];
    if (next !== undefined) setOverlay(next);
  };

  const imageUrlOf = (row: SplitRow) =>
    `${
      row.source === "original"
        ? client.originalUrl(archive, row.names[0])
        : client.imageUrl(archive, row.names[0])
    }&v=${reloadKey}`;

  const opened = overlay === null ? null : (rows[overlay] ?? null);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 見出しの行は高さを固定する。文が入れ替わるたびに折り返して格子が
          押し下がると、いま見ていたページが視界から外れる */}
      <div className="flex h-7 shrink-0 items-center gap-2">
        <h2
          className="min-w-0 truncate text-[13px] font-semibold"
          data-testid="split-archive-name"
        >
          {archiveName ?? "ページ分割"}
        </h2>
        {onChangeArchive ? (
          <Button
            variant="ghost"
            className="shrink-0"
            data-testid="change-archive"
            onClick={onChangeArchive}
          >
            <FolderOpen />
            別のファイルを選ぶ
          </Button>
        ) : null}
        <span
          className="tabular shrink-0 text-[12px] text-ink-faint"
          data-testid="split-page-count"
        >
          {pageCount} ページ
        </span>
        <span
          className="flex shrink-0 items-center gap-1.5"
          title="見開きと判定したページをまとめて選ぶ・外す"
        >
          <Checkbox
            data-testid="split-master"
            aria-label="見開きと判定したページをまとめて選ぶ・外す"
            checked={master}
            disabled={detected.length === 0}
            onCheckedChange={toggleAll}
          />
          <span
            className="tabular text-[12px] text-ink-muted"
            data-testid="split-detected-count"
          >
            見開き {detected.length} 枚
          </span>
        </span>
        <label className="flex shrink-0 items-center gap-2 text-[12px] text-ink-muted">
          表示サイズ
          <input
            type="range"
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
          title="チェックと分割位置を開いたときの状態に戻す"
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
          <Scissors />
          この内容で分割する
        </Button>
      </div>

      <p className="shrink-0 text-[11.5px] leading-[18px] text-ink-faint">
        チェックで分ける・分けないを選ぶ ・ 線を掴んで分割位置を動かす ・
        画像をクリックで大きく表示 ・ 右半分が先のページになります（右綴じ）
      </p>

      {/* スクロールするのはこの格子であって窓ではない。行の高さは中身に
          合わせる（auto-rows-max）。auto のままだと、高さの決まった格子を
          行数で割った高さへ押し込められる */}
      <div
        ref={gridRef}
        data-testid="split-grid"
        className="grid min-h-0 flex-1 auto-rows-max content-start gap-3 overflow-y-auto"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))`,
        }}
      >
        {columnWidth > 0
          ? rows.map((row, index) => {
              const wide = isWide(row);
              const span = wide && columns >= 2;
              return (
                <SplitCard
                  key={index}
                  index={index}
                  label={numberLabel(numbers[index])}
                  pending={isPending(row)}
                  checked={row.checked}
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
            })
          : null}
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
    </section>
  );
}
