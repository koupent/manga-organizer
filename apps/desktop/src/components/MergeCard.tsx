import { Link2, Scissors } from "lucide-react";
import { cn } from "../lib/utils";
import { fitInside } from "../lib/stage";
import { Badge } from "./ui/badge";

type Picture = { imageUrl: string; width: number; height: number };

type MergeCardProps = {
  /** 先頭の行の位置。0 から数える */
  index: number;
  /** 番号の札に出す文字。"3" か "3–4" */
  label: string;
  /** 書き込む前と違うか */
  pending: boolean;
  /** 前後の送りボタンで、いま指しているカードか */
  focused: boolean;
  /**
   * カードの種類。
   * - page: 1 ページ（または触らない横長）
   * - candidate: 継ぎ目の色がつながる 2 枚。結合した後の姿を点線で出す
   * - joined: 結合すると決めた 2 枚
   */
  kind: "page" | "candidate" | "joined";
  /** 実際に 2 列を跨がせるか */
  span: boolean;
  boxWidth: number;
  boxHeight: number;
  page: Picture;
  /** 結合する相手（次のページ）。右綴じなので左に並べる */
  partner?: Picture;
  /** いま ZIP の中で 2 ページに割れている対か */
  applied: boolean;
  /** ②で作った見開き（結合した・分割を戻した）か */
  keptWhole: boolean;
  /** 候補を結合する */
  onMerge?: () => void;
  /** 結合をやめる */
  onUnmerge?: () => void;
  /** 次のページと結合する（候補に無い 2 枚を手で結合する） */
  onMergeNext?: () => void;
};

/**
 * ②「見開きにする」のカード（#153）。
 *
 * 候補は、結合した後の見開きの姿（右に先のページ）で見せる。viewer での
 * 見え方そのものなので、格子が左から右へ並んでいても迷わない。
 */
export function MergeCard({
  index,
  label,
  pending,
  focused,
  kind,
  span,
  boxWidth,
  boxHeight,
  page,
  partner,
  applied,
  keptWhole,
  onMerge,
  onUnmerge,
  onMergeNext,
}: MergeCardProps) {
  // 結合するときは、高い方に揃えて 2 枚を横に並べた寸法で置く。サイドカーが
  // 貼り合わせるときと同じ揃え方
  const joinedHeight = partner
    ? Math.max(page.height, partner.height)
    : page.height;
  const ownWidth = (page.width * joinedHeight) / page.height;
  const partnerWidth = partner
    ? (partner.width * joinedHeight) / partner.height
    : 0;
  const display = fitInside(
    { width: ownWidth + partnerWidth, height: joinedHeight },
    { width: boxWidth, height: boxHeight },
  );
  const scale = display.height / joinedHeight;
  const candidate = kind === "candidate";

  return (
    <div
      // 送りボタンで指したカードへフォーカスを移し、キーで結合できるようにする
      tabIndex={-1}
      className={cn(
        "group flex flex-col overflow-hidden rounded-card border border-line outline-none",
        "bg-surface transition-colors hover:border-line-strong",
        span && "col-span-2",
        focused && "border-brand ring-2 ring-brand/40",
      )}
      data-testid="merge-card"
      data-index={index}
      data-kind={kind}
      data-focused={focused}
    >
      <div
        className="relative flex flex-none items-center justify-center bg-canvas"
        style={{ height: boxHeight }}
      >
        <div
          className={cn(
            "relative flex overflow-hidden",
            candidate &&
              "outline-2 outline-offset-2 outline-warn outline-dashed",
          )}
          style={{ width: display.width, height: display.height }}
        >
          {partner ? (
            <img
              data-testid="merge-partner-image"
              className="block h-full"
              style={{ width: partnerWidth * scale }}
              src={partner.imageUrl}
              alt={`${label} ページの左に並ぶページ`}
              loading="lazy"
            />
          ) : null}
          <img
            data-testid="merge-image"
            className="block h-full"
            style={{ width: ownWidth * scale }}
            src={page.imageUrl}
            alt={`${label} ページ`}
            loading="lazy"
          />
          {candidate ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 border-l-2 border-dashed border-warn"
              style={{ left: partnerWidth * scale - 1 }}
            />
          ) : null}
        </div>
        {/* 絵の上に載るので、半透明の地では読めない。地を塗りつぶす */}
        {kind !== "page" ? (
          <Badge
            data-testid="merge-badge"
            className={cn(
              "pointer-events-none absolute top-2 left-2 font-semibold shadow",
              candidate ? "bg-warn text-canvas" : "bg-brand text-brand-ink",
            )}
          >
            {candidate ? "結合候補" : "結合する"}
          </Badge>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 border-t border-line px-2 py-1.5">
        <span
          data-testid="merge-number"
          data-pending={pending}
          className={cn(
            "tabular min-w-6 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold",
            pending ? "bg-brand text-brand-ink" : "bg-surface-2 text-ink-muted",
          )}
        >
          {label}
        </span>
        {applied ? (
          <Badge tone="ok" data-testid="merge-applied">
            分割済み
          </Badge>
        ) : null}
        {keptWhole ? (
          <Badge data-testid="merge-kept-whole">見開き</Badge>
        ) : null}
        <div className="flex-1" />
        {onMerge ? (
          <button
            type="button"
            data-testid="merge-accept"
            title={`${label} ページを 1 枚の見開きに結合する（Enter）`}
            className="flex shrink-0 items-center gap-1 rounded bg-brand px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-brand-ink hover:bg-brand/85"
            onClick={onMerge}
          >
            <Link2 className="size-3.5" />
            結合
          </button>
        ) : null}
        {onUnmerge ? (
          <button
            type="button"
            data-testid="merge-undo"
            title={`${label} ページの結合を解く`}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap text-ink-muted hover:bg-surface-2 hover:text-ink"
            onClick={onUnmerge}
          >
            <Scissors className="size-3.5" />
            解く
          </button>
        ) : null}
        {onMergeNext ? (
          <button
            type="button"
            data-testid="split-merge"
            title={`${label} ページを次のページと結合する`}
            aria-label={`${label} ページを次のページと結合する`}
            // 単ページの数だけ並ぶので、普段は隠して指したカードにだけ出す
            className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] whitespace-nowrap text-ink-faint opacity-0 transition-colors group-hover:opacity-100 hover:bg-surface-2 hover:text-ink focus-visible:opacity-100"
            onClick={onMergeNext}
          >
            <Link2 className="size-3.5" />
            次と結合
          </button>
        ) : null}
      </div>
    </div>
  );
}
