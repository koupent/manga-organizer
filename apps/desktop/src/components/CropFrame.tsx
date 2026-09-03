import { useRef, type PointerEvent as ReactPointerEvent } from "react";

/** viewer が表紙を描く枠の縦横比 */
export const TARGET_RATIO = 2 / 3;

/** 切り抜き範囲。単位は「元画像の画素」で、表示上の大きさには依存しない */
export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 画像の寸法（元画像の画素） */
export type ImageSize = { width: number; height: number };

/** 枠を小さくできる下限。元画像に対する割合で決め、画像の大小に付いていかせる */
const MIN_WIDTH_FRACTION = 0.1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 画像に収まる最大の 2:3 を中央に置いた初期状態。
 *
 * viewer は表紙を 2:3 の中央クロップで描く。既定を viewer の見え方に
 * 合わせておけば、何も触らずに確定しても表示は変わらない。
 */
export function defaultCrop(image: ImageSize): CropRect {
  const width = Math.min(image.width, image.height * TARGET_RATIO);
  const height = width / TARGET_RATIO;
  return {
    x: (image.width - width) / 2,
    y: (image.height - height) / 2,
    width,
    height,
  };
}

/** 枠を画像の中に収めたまま動かす */
function movedCrop(start: CropRect, dx: number, dy: number, image: ImageSize) {
  return {
    ...start,
    x: clamp(start.x + dx, 0, image.width - start.width),
    y: clamp(start.y + dy, 0, image.height - start.height),
  };
}

/**
 * 角を掴んで大きさを変える。縦横比は 2:3 のまま動かさない。
 *
 * 比率を固定するのは、viewer が表紙を 2:3 に切って描くため。自由な比率で
 * 切ると、画面で見た範囲と一覧での見え方がずれる。
 *
 * 縦横どちらへ動かしても効くよう、動きの大きい方の軸を寸法の手がかりにする。
 */
function resizedCrop(
  start: CropRect,
  dx: number,
  dy: number,
  image: ImageSize,
) {
  const requested =
    Math.abs(dx) >= Math.abs(dy)
      ? start.width + dx
      : (start.height + dy) * TARGET_RATIO;
  const width = clamp(
    requested,
    image.width * MIN_WIDTH_FRACTION,
    Math.min(image.width - start.x, (image.height - start.y) * TARGET_RATIO),
  );
  return { ...start, width, height: width / TARGET_RATIO };
}

/**
 * 枠を、サイドカーが受け取る元画像の画素座標 (left, upper, right, lower) に直す。
 *
 * 枠も同じ単位で持っているので、ここでは端数を落として画像の内側へ収めるだけ。
 * 表示上の座標をそのまま送ると、縮小されたぶんだけ違う範囲が切られる。
 */
export function toCropBox(
  crop: CropRect,
  image: ImageSize,
): [number, number, number, number] {
  const left = clamp(Math.round(crop.x), 0, image.width - 1);
  const upper = clamp(Math.round(crop.y), 0, image.height - 1);
  return [
    left,
    upper,
    clamp(Math.round(crop.x + crop.width), left + 1, image.width),
    clamp(Math.round(crop.y + crop.height), upper + 1, image.height),
  ];
}

type CropFrameProps = {
  image: ImageSize;
  crop: CropRect;
  onChange: (crop: CropRect) => void;
};

/**
 * 表示中の画像に重ねる 2:3 の切り抜き枠。
 *
 * 枠は元画像の画素で持ち、描画だけを割合に直す。表示は縮小されているので、
 * 画面上の座標のまま持つと、そのまま送ったときに意図しない範囲が切られる。
 */
export function CropFrame({ image, crop, onChange }: CropFrameProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    resize: boolean;
    originX: number;
    originY: number;
    start: CropRect;
  } | null>(null);

  /** 画面上の移動量を元画像の画素へ直す。縮小率は実際の描画から測る */
  const toImagePixels = (dx: number, dy: number) => {
    const box = rootRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { dx: 0, dy: 0 };
    return {
      dx: (dx * image.width) / box.width,
      dy: (dy * image.height) / box.height,
    };
  };

  const beginDrag = (event: ReactPointerEvent, resize: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    // 掴んだ要素へ以後の動きを寄せる。枠の外へ出ても追随させたい
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      resize,
      originX: event.clientX,
      originY: event.clientY,
      start: crop,
    };
  };

  const continueDrag = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const moved = toImagePixels(
      event.clientX - drag.originX,
      event.clientY - drag.originY,
    );
    const apply = drag.resize ? resizedCrop : movedCrop;
    onChange(apply(drag.start, moved.dx, moved.dy, image));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const percent = (value: number, total: number) => `${(value / total) * 100}%`;

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0">
      <div
        data-testid="crop-frame"
        className="pointer-events-auto absolute cursor-move border-2 border-brand bg-brand/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
        style={{
          left: percent(crop.x, image.width),
          top: percent(crop.y, image.height),
          width: percent(crop.width, image.width),
          height: percent(crop.height, image.height),
        }}
        onPointerDown={(event) => beginDrag(event, false)}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* 掴む所は枠の内側に置く。はみ出させると画像の縁で切り取られ、掴めなくなる */}
        <span
          data-testid="crop-handle"
          aria-hidden
          className="absolute right-0 bottom-0 size-4 cursor-nwse-resize rounded-full border border-white bg-brand"
          onPointerDown={(event) => beginDrag(event, true)}
        />
      </div>
    </div>
  );
}
