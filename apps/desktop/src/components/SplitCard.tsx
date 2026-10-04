import { Link2, Undo2, ZoomIn } from "lucide-react";
import type { Answer, Proposal } from "../lib/split";
import { cn } from "../lib/utils";
import { fitInside } from "../lib/stage";
import { Badge } from "./ui/badge";
import { Checkbox } from "./ui/checkbox";
import { SplitLine } from "./SplitLine";

type SplitCardProps = {
  /** ページ順での位置。0 から数える */
  index: number;
  /** 番号の札に出す文字。"3" か "3–4" */
  label: string;
  /** 書き込む前と違うか */
  pending: boolean;
  /**
   * いま ZIP の中で 2 ページに割れているか（#132）。割った対は割る前の見開きの
   * 絵で出すので、印が無いと割れたのかどうかが絵からは分からない
   */
  applied: boolean;
  /** 前後の提案へ送るボタンで、いま指している行か（#131 #151） */
  focused: boolean;
  checked: boolean;
  /** この行への分割・結合の提案と、その答え（#151） */
  proposal: Proposal | null;
  /** 見開きのまま残すと決めた横長（結合した・分割を戻した）か */
  keptWhole: boolean;
  /** 2 列ぶんを占める横長か */
  wide: boolean;
  /** 実際に 2 列を跨がせるか。1 列しか無い窓では跨がせられない */
  span: boolean;
  /** 絵の箱。行をまたいで同じ高さにする */
  boxWidth: number;
  boxHeight: number;
  /** 元画像の寸法。割る位置はこの座標で持つ */
  width: number;
  height: number;
  x: number;
  imageUrl: string;
  /**
   * 結合する（結合を提案している）次のページ（#139 #151）。あれば、結合した
   * 後の見開きの姿で出す。右綴じなので、次のページは左に並ぶ
   */
  partner?: { imageUrl: string; width: number; height: number };
  /** 次のページとの結合を切り替える。渡さなければ結合の操作を出さない */
  onMergeNext?: () => void;
  onAnswer: (answer: Answer) => void;
  onToggle: () => void;
  onMoveSplit: (x: number) => void;
  onZoom: () => void;
};

/** 提案の札の文言。未決は「何を勧めているか」、採用は「何が起きるか」 */
const PROPOSAL_TEXT = {
  split: { open: "分割の提案", accepted: "分けます" },
  merge: { open: "結合の提案", accepted: "結合します" },
} as const;

/**
 * 1 行ぶんのカード。
 *
 * **ファイル名は受け取らないし、出さない。** 割った対は 2 つの名前を持ち、
 * まだ割っていない見開きは 1 つしか持たない。どちらを出しても「元画像」と
 * 「割った半分」の区別が画面に現れ、利用者が知らずに済むはずのものを
 * 知らせてしまう。渡すのは絵の URL と、数え直した番号だけ。
 *
 * 提案（#151）は、採用した後の姿で見せる。分割は分ける位置の点線、結合は
 * 貼り合わせた見開きの姿。押す前に、絵がそうなってよいかを目で確かめられる。
 */
export function SplitCard({
  index,
  label,
  pending,
  applied,
  focused,
  checked,
  proposal,
  keptWhole,
  wide,
  span,
  boxWidth,
  boxHeight,
  width,
  height,
  x,
  imageUrl,
  partner,
  onMergeNext,
  onAnswer,
  onToggle,
  onMoveSplit,
  onZoom,
}: SplitCardProps) {
  // 結合するときは、高い方に揃えて 2 枚を横に並べた寸法で置く。サイドカーが
  // 貼り合わせるときと同じ揃え方
  const joinedHeight = partner ? Math.max(height, partner.height) : height;
  const ownWidth = (width * joinedHeight) / height;
  const partnerWidth = partner
    ? (partner.width * joinedHeight) / partner.height
    : 0;
  // 絵は箱に収まる最大の大きさで置く。線の位置は絵そのものに合わせたいので、
  // 枠は絵と同じ寸法にし、object-fit の余白が間に入らないようにする
  const display = fitInside(
    { width: ownWidth + partnerWidth, height: joinedHeight },
    { width: boxWidth, height: boxHeight },
  );
  const scale = display.height / joinedHeight;

  const open = proposal?.state === "open";
  const declined = proposal?.state === "declined";
  const kind = proposal?.kind;
  // 未決の提案は点線で、採用した後の姿の「下書き」として描く
  const draftLine =
    open && kind === "split"
      ? (x / width) * display.width
      : open && kind === "merge"
        ? partnerWidth * scale
        : null;

  const splitLabel = `${label} ページを 2 ページに分ける`;
  const zoomLabel = `${label} ページを大きく表示`;
  const mergeLabel = partner
    ? `${label} ページの結合をやめる`
    : `${label} ページを次のページと結合する`;
  const proposalName =
    kind === "merge" ? "結合" : kind === "split" ? "分割" : "";

  return (
    <div
      // 送りボタンで指したカードへフォーカスを移し、キーで答えられるようにする
      tabIndex={-1}
      className={cn(
        "group flex flex-col overflow-hidden rounded-card border border-line outline-none",
        "bg-surface transition-colors hover:border-line-strong",
        span && "col-span-2",
        focused && "border-brand ring-2 ring-brand/40",
      )}
      data-testid="split-card"
      data-index={index}
      data-checked={checked}
      data-wide={wide}
      data-focused={focused}
      data-merging={partner !== undefined}
      data-proposal={kind ?? "none"}
      data-proposal-state={proposal?.state ?? "none"}
    >
      <div
        className={cn(
          "relative flex flex-none items-center justify-center bg-canvas",
          !partner && "cursor-zoom-in",
        )}
        style={{ height: boxHeight }}
        // 結合する 2 枚の拡大表示は持たない。拡大表示は 1 枚を割る道具
        onClick={partner ? undefined : onZoom}
      >
        <div
          className={cn(
            "relative flex overflow-hidden",
            open && "outline-2 outline-offset-2 outline-warn outline-dashed",
          )}
          style={{ width: display.width, height: display.height }}
        >
          {partner ? (
            <img
              data-testid="split-partner-image"
              className="block h-full"
              style={{ width: partnerWidth * scale }}
              src={partner.imageUrl}
              alt={`${label} ページに結合する次のページ`}
              loading="lazy"
            />
          ) : null}
          <img
            data-testid="split-image"
            className="block h-full"
            style={{ width: ownWidth * scale }}
            src={imageUrl}
            // 名前の代わりに番号を読み上げる。名前は画面のどこにも出さない
            alt={`${label} ページ`}
            loading="lazy"
          />
          {checked ? (
            <SplitLine
              label={label}
              x={x}
              width={width}
              displayWidth={display.width}
              onChange={onMoveSplit}
            />
          ) : null}
          {draftLine !== null ? (
            <div
              data-testid="split-proposal-line"
              aria-hidden
              className="pointer-events-none absolute inset-y-0 border-l-2 border-dashed border-warn"
              style={{ left: draftLine - 1 }}
            />
          ) : null}
        </div>
        {/* 絵の上に載るので、半透明の地では読めない。地を塗りつぶす */}
        {proposal && !declined ? (
          <Badge
            data-testid="split-proposal"
            className={cn(
              "pointer-events-none absolute top-2 left-2 font-semibold shadow",
              open ? "bg-warn text-canvas" : "bg-brand text-brand-ink",
            )}
          >
            {PROPOSAL_TEXT[proposal.kind][open ? "open" : "accepted"]}
          </Badge>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 border-t border-line px-2 py-1.5">
        {/* 名乗るのは番号。同じ形の操作がページの数だけ並ぶので、
              「2 ページに分ける」だけでは読み上げの操作一覧でどのページの
              ものか永久に分からない。名前ではなく番号にするのは、
              割る前の 1 枚と割った半分の区別を出さないため */}
        {/* 結合する 2 枚は割れない。割るなら、結合をやめてから。提案に
              答える前・断った後は、答える操作の方を出す */}
        {partner || open || declined ? null : (
          <Checkbox
            data-testid="split-check"
            title={splitLabel}
            aria-label={splitLabel}
            checked={checked}
            onCheckedChange={onToggle}
            className={cn(
              // 提案に無い分割は、指したカードにだけ出す（#151）
              !checked &&
                !applied &&
                !wide &&
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            )}
          />
        )}
        <span
          data-testid="split-number"
          data-pending={pending}
          className={cn(
            "tabular min-w-6 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold",
            pending ? "bg-brand text-brand-ink" : "bg-surface-2 text-ink-muted",
          )}
        >
          {label}
        </span>
        {applied ? (
          <Badge tone="ok" data-testid="split-applied">
            分割済み
          </Badge>
        ) : null}
        {keptWhole && !checked ? (
          <Badge
            data-testid="split-kept-whole"
            title="結合した・分割を戻した見開きです。分けるときはチェックを入れます"
          >
            見開きのまま
          </Badge>
        ) : null}
        {declined ? (
          <span
            data-testid="split-declined"
            className="text-[11px] whitespace-nowrap text-ink-faint"
          >
            このまま
          </span>
        ) : null}
        <div className="flex-1" />
        {open ? (
          <>
            <button
              type="button"
              data-testid="split-accept"
              title={`${label} ページの${proposalName}の提案を採用する（Enter）`}
              className="shrink-0 rounded bg-brand px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-brand-ink hover:bg-brand/85"
              onClick={() => onAnswer("accept")}
            >
              採用
            </button>
            <button
              type="button"
              data-testid="split-decline"
              title={`${label} ページの${proposalName}の提案を見送る（Backspace）`}
              className="shrink-0 rounded bg-surface-2 px-2 py-0.5 text-[11px] whitespace-nowrap text-ink-muted hover:text-ink"
              onClick={() => onAnswer("decline")}
            >
              このまま
            </button>
          </>
        ) : declined ? (
          <button
            type="button"
            data-testid="split-reopen"
            title={`${label} ページの${proposalName}の提案に戻す`}
            aria-label={`${label} ページの${proposalName}の提案に戻す`}
            className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-surface-2 hover:text-ink"
            onClick={() => onAnswer("reopen")}
          >
            <Undo2 className="size-3.5" />
          </button>
        ) : onMergeNext ? (
          <button
            type="button"
            data-testid="split-merge"
            title={mergeLabel}
            aria-label={mergeLabel}
            aria-pressed={partner !== undefined}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] whitespace-nowrap transition-colors hover:bg-surface-2",
              // 単ページの数だけ並ぶので、普段は隠して指したカードにだけ出す
              partner
                ? "text-brand"
                : "text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100",
            )}
            onClick={onMergeNext}
          >
            <Link2 className="size-3.5" />
            {partner ? "結合をやめる" : "次と結合"}
          </button>
        ) : null}
        {partner ? null : (
          <button
            type="button"
            data-testid="split-zoom"
            title={zoomLabel}
            aria-label={zoomLabel}
            className="rounded p-0.5 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface-2 hover:text-ink focus-visible:opacity-100"
            onClick={onZoom}
          >
            <ZoomIn className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
