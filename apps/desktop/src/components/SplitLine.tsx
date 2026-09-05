import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "../lib/utils";
import { clampSplit, splitBounds } from "../lib/split";

/** 矢印キーで動く量。Shift を添えると粗く動かせる */
const KEY_STEP = 1;
const KEY_STEP_FAST = 10;

type SplitLineProps = {
  /** 割る位置。元画像の画素 */
  x: number;
  /** 元画像の幅。x はこの座標で読む */
  width: number;
  /** いま描かれている絵の幅。掴んで運んだ距離をこれで元の画素へ直す */
  displayWidth: number;
  /** 拡大表示の中か。掴む所と摘みを大きくする */
  overlay?: boolean;
  onChange: (x: number) => void;
};

/**
 * 絵に重ねる分割線。
 *
 * 位置は元画像の画素で持ち、描画のときだけ割合に直す。画面上の座標のまま
 * 持つと、窓の大きさや表示サイズを変えただけで、送る値と切れる場所がずれる。
 *
 * 掴む所は線より広く取る。2px の線をそのまま的にすると、掴めるまで何度も
 * 狙い直すことになる。
 */
export function SplitLine({
  x,
  width,
  displayWidth,
  overlay = false,
  onChange,
}: SplitLineProps) {
  const drag = useRef<{ originX: number; start: number } | null>(null);
  const bounds = splitBounds(width);

  const beginDrag = (event: ReactPointerEvent) => {
    // 絵を押すと拡大表示が開く。線を掴んだときはそちらへ渡さない
    event.preventDefault();
    event.stopPropagation();
    // 掴んだ要素へ以後の動きを寄せる。絵の外へ出ても追随させたい
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { originX: event.clientX, start: x };
  };

  const continueDrag = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current || displayWidth <= 0) return;
    const moved = ((event.clientX - current.originX) * width) / displayWidth;
    onChange(clampSplit(current.start + moved, width));
  };

  const endDrag = () => {
    drag.current = null;
  };

  const nudge = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const step = (event.shiftKey ? KEY_STEP_FAST : KEY_STEP) * direction;
    // 線に焦点があるあいだの ← → は位置の微調整。前後の見開きへ移る操作へは
    // 渡さない。渡すと、1px 動かすつもりで別のページへ飛ばされる
    event.preventDefault();
    event.stopPropagation();
    onChange(clampSplit(x + step, width));
  };

  return (
    <div
      className="pointer-events-none absolute inset-y-0 w-0"
      style={{ left: `${(x / width) * 100}%` }}
    >
      <div
        data-testid={overlay ? "split-dialog-handle" : "split-handle"}
        role="slider"
        tabIndex={0}
        aria-label="分割位置"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={x}
        title="掴んで分割位置を動かす"
        className={cn(
          "group pointer-events-auto absolute inset-y-0 cursor-col-resize outline-none",
          overlay ? "-left-3 w-6" : "-left-2 w-4",
        )}
        onPointerDown={beginDrag}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={nudge}
        // 掴んで離した後の click は、押した所（線）から上がってくる。
        // 止めないと、動かし終えるたびに拡大表示が開く
        onClick={(event) => event.stopPropagation()}
      >
        {/* 明るい絵の上でも暗い絵の上でも見えるよう、線に 1px の縁を添える */}
        <span className="absolute inset-y-0 left-1/2 -ml-px w-0.5 bg-brand shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" />
        <span
          className={cn(
            "absolute top-1/2 left-1/2 rounded-full border border-white bg-brand",
            "shadow-[0_1px_2px_rgba(0,0,0,0.5)]",
            "group-focus-visible:ring-2 group-focus-visible:ring-brand/40",
            overlay ? "-mt-2.5 -ml-2.5 size-5" : "-mt-2 -ml-2 size-4",
          )}
        />
      </div>
    </div>
  );
}
