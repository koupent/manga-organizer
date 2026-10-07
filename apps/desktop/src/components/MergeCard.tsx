import { Link2 } from "lucide-react";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { PagePicture, type Picture } from "./PagePicture";
import { PageCard } from "./PageCard";

/**
 * 「結合…」で相手を選んでいる間の、このカードの立場（#154）。
 * - self: 選び始めたカード
 * - partner: 相手に選べるカード
 * - dimmed: どちらでもない。薄くして押せなくする
 */
export type PickRole = "none" | "self" | "partner" | "dimmed";

type MergeCardProps = {
  /** 先頭の行の位置。0 から数える */
  index: number;
  /** 割った対の半分のとき、先（0）か後（1）か */
  part?: 0 | 1;
  /** 番号の札に出す文字。"3" か "3–4" */
  label: string;
  /** 書き込む前と違うか */
  pending: boolean;
  /** 前後の送りボタンで、いま指しているカードか */
  focused: boolean;
  /**
   * カードの種類。
   * - page: 1 ページ
   * - candidate: 継ぎ目の色がつながる 2 枚。結合した後の姿を点線で出す
   * - joined: 結合すると決めた 2 枚
   * - spread: 横長のページ（見開き）
   */
  kind: "page" | "candidate" | "joined" | "spread";
  /** 実際に 2 列を跨がせるか */
  span: boolean;
  boxWidth: number;
  boxHeight: number;
  page: Picture;
  /** 結合する相手（次のページ）。右綴じなので左に並べる */
  partner?: Picture;
  /** 割った対を戻す候補で、継ぎ目を点線で示す位置（page の座標） */
  seamX?: number;
  pick: PickRole;
  /** 候補を結合する */
  onMerge?: () => void;
  /** 未保存の結合を取り消す */
  onCancelMerge?: () => void;
  /** 「結合…」で相手を選び始める */
  onPick?: () => void;
  /** 相手に選ぶ */
  onChoose?: () => void;
  /** 相手を選ぶのをやめる */
  onCancelPick?: () => void;
};

/**
 * ②「見開きにする」のカード（#153 #154）。
 *
 * 候補は、結合した後の見開きの姿（右に先のページ）で見せる。viewer での
 * 見え方そのものなので、格子が左から右へ並んでいても迷わない。
 */
export function MergeCard({
  index,
  part,
  label,
  pending,
  focused,
  kind,
  span,
  boxWidth,
  boxHeight,
  page,
  partner,
  seamX,
  pick,
  onMerge,
  onCancelMerge,
  onPick,
  onChoose,
  onCancelPick,
}: MergeCardProps) {
  const candidate = kind === "candidate";
  const badge =
    kind === "candidate"
      ? { text: "結合候補", className: "bg-warn text-canvas" }
      : kind === "joined"
        ? { text: "結合する", className: "bg-brand text-brand-ink" }
        : null;

  return (
    <PageCard
      mode="merge"
      index={index}
      part={part}
      label={label}
      pending={pending}
      focused={focused}
      span={span}
      boxHeight={boxHeight}
      className={cn(
        pick === "self" && "border-brand ring-2 ring-brand",
        pick === "partner" && "border-warn ring-2 ring-warn",
        pick === "dimmed" && "pointer-events-none opacity-40",
      )}
      data-kind={kind}
      data-pick={pick}
      status={
        kind === "spread" ? (
          <Badge data-testid="merge-spread">見開き</Badge>
        ) : null
      }
      actions={
        <>
          {pick === "self" ? (
            <>
              <span className="text-[11px] whitespace-nowrap text-ink-muted">
                相手を押す
              </span>
              <button
                type="button"
                data-testid="merge-pick-cancel"
                title="結合する相手を選ぶのをやめる（Esc）"
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap text-ink-muted hover:bg-surface-2 hover:text-ink"
                onClick={onCancelPick}
              >
                やめる
              </button>
            </>
          ) : null}
          {pick !== "self" && onMerge ? (
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
          {pick !== "self" && onCancelMerge ? (
            <button
              type="button"
              data-testid="merge-undo"
              title={`${label} ページの未保存の結合を取り消す`}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap text-ink-muted hover:bg-surface-2 hover:text-ink"
              onClick={onCancelMerge}
            >
              結合を取り消す
            </button>
          ) : null}
          {pick === "none" && onPick ? (
            <button
              type="button"
              data-testid="merge-pick"
              title={`${label} ページと結合する相手を選ぶ`}
              // 単ページの数だけ並ぶので、普段は隠して指したカードにだけ出す
              className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] whitespace-nowrap text-ink-faint opacity-0 transition-colors group-hover:opacity-100 hover:bg-surface-2 hover:text-ink focus-visible:opacity-100"
              onClick={onPick}
            >
              <Link2 className="size-3.5" />
              結合…
            </button>
          ) : null}
        </>
      }
    >
      <PagePicture
        label={label}
        page={page}
        partner={partner}
        boxWidth={boxWidth}
        boxHeight={boxHeight}
        draft={candidate}
        imageTestId="merge-image"
        partnerTestId="merge-partner-image"
      >
        {(display) =>
          candidate && (partner || seamX !== undefined) ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 border-l-2 border-dashed border-warn"
              style={{
                left:
                  (partner
                    ? display.seam
                    : (seamX! / page.width) * display.width) - 1,
              }}
            />
          ) : null
        }
      </PagePicture>
      {/* 絵の上に載るので、半透明の地では読めない。地を塗りつぶす */}
      {badge ? (
        <Badge
          data-testid="merge-badge"
          className={cn(
            "pointer-events-none absolute top-2 left-2 font-semibold shadow",
            badge.className,
          )}
        >
          {badge.text}
        </Badge>
      ) : null}
      {pick === "partner" ? (
        <button
          type="button"
          data-testid="merge-partner"
          className="absolute inset-0 flex items-center justify-center bg-warn/15 text-[12px] font-semibold"
          onClick={onChoose}
        >
          <span className="rounded bg-warn px-2 py-1 text-canvas shadow">
            ここと結合
          </span>
        </button>
      ) : null}
    </PageCard>
  );
}
