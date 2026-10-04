import { ZoomIn } from "lucide-react";
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
  /** 前後の送りボタンで、いま指している行か（#131） */
  focused: boolean;
  checked: boolean;
  /** ①で分ける対象（まだ割っていない横長）か（#153） */
  target: boolean;
  /** 見開きのまま残すと決めた横長（②で作った見開き）か */
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
  onToggle: () => void;
  onMoveSplit: (x: number) => void;
  onZoom: () => void;
};

/**
 * ①「単ページにする」の 1 行ぶんのカード（#153）。
 *
 * **ファイル名は受け取らないし、出さない。** 割った対は 2 つの名前を持ち、
 * まだ割っていない見開きは 1 つしか持たない。どちらを出しても「元画像」と
 * 「割った半分」の区別が画面に現れ、利用者が知らずに済むはずのものを
 * 知らせてしまう。渡すのは絵の URL と、数え直した番号だけ。
 *
 * まだ選んでいない対象は、分ける位置を点線で示す。押す前に、そこで分けて
 * よいかを目で確かめられる。
 */
export function SplitCard({
  index,
  label,
  pending,
  applied,
  focused,
  checked,
  target,
  keptWhole,
  wide,
  span,
  boxWidth,
  boxHeight,
  width,
  height,
  x,
  imageUrl,
  onToggle,
  onMoveSplit,
  onZoom,
}: SplitCardProps) {
  // 絵は箱に収まる最大の大きさで置く。線の位置は絵そのものに合わせたいので、
  // 枠は絵と同じ寸法にし、object-fit の余白が間に入らないようにする
  const display = fitInside(
    { width, height },
    { width: boxWidth, height: boxHeight },
  );
  const draft = target && !checked;

  const splitLabel = `${label} ページを 2 ページに分ける`;
  const zoomLabel = `${label} ページを大きく表示`;

  return (
    <div
      // 送りボタンで指したカードへフォーカスを移し、キーで切り替えられるようにする
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
      data-target={target}
    >
      {/* キーで拡大するときは、下の拡大ボタンを使う */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className="relative flex flex-none cursor-zoom-in items-center justify-center bg-canvas"
        style={{ height: boxHeight }}
        onClick={onZoom}
      >
        <div
          className={cn(
            "relative flex overflow-hidden",
            draft && "outline-2 outline-offset-2 outline-warn outline-dashed",
          )}
          style={{ width: display.width, height: display.height }}
        >
          <img
            data-testid="split-image"
            className="block h-full w-full"
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
          ) : draft ? (
            <div
              data-testid="split-draft-line"
              aria-hidden
              className="pointer-events-none absolute inset-y-0 border-l-2 border-dashed border-warn"
              style={{ left: (x / width) * display.width - 1 }}
            />
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-1.5 border-t border-line px-2 py-1.5">
        {/* 名乗るのは番号。同じ形の操作がページの数だけ並ぶので、
            「2 ページに分ける」だけでは読み上げの操作一覧でどのページの
            ものか永久に分からない。名前ではなく番号にするのは、
            割る前の 1 枚と割った半分の区別を出さないため */}
        <Checkbox
          data-testid="split-check"
          title={splitLabel}
          aria-label={splitLabel}
          checked={checked}
          onCheckedChange={onToggle}
          className={cn(
            // 横長でないページを分けることは少ない。指したカードにだけ出す
            !checked &&
              !applied &&
              !wide &&
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        />
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
            title="②で作った見開きです。「すべて分割」では分けません"
          >
            見開き
          </Badge>
        ) : null}
        <div className="flex-1" />
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
      </div>
    </div>
  );
}
