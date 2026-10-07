import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

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

/** これより横長なら見開き。manga_core.cover_editor と同じ値 */
const SPREAD_RATIO = 1.2;

/** 90 度単位の時計回りの回転。サイドカーもこの 4 つしか受け付けない */
export type QuarterTurn = 0 | 90 | 180 | 270;

/** 時計回りに 1 つ進めた角度 */
export function nextTurn(angle: QuarterTurn): QuarterTurn {
  return ((angle + 90) % 360) as QuarterTurn;
}

/** 打ち消す角度。回した後の座標を元へ戻すときに使う */
export function oppositeTurn(angle: QuarterTurn): QuarterTurn {
  return ((360 - angle) % 360) as QuarterTurn;
}

/** 回した後の寸法。90 度と 270 度では縦横が入れ替わる */
export function rotatedSize(image: ImageSize, angle: QuarterTurn): ImageSize {
  if (angle % 180 === 0) return { width: image.width, height: image.height };
  return { width: image.height, height: image.width };
}

/**
 * 枠を、画像を時計回りに angle だけ回した後の座標へ移す。
 *
 * 回転が 90 度単位である限り、長方形は回しても長方形のままなので、四隅を
 * 追わずに寸法の入れ替えと平行移動だけで書ける。
 *
 * 逆向きへ戻すときは、回した後の寸法と oppositeTurn(angle) を渡す。
 * 画面では回した後の座標で枠を持ち、サイドカーへ渡すときだけ元へ戻す。
 */
export function rotateCrop(
  crop: CropRect,
  image: ImageSize,
  angle: QuarterTurn,
): CropRect {
  if (angle === 90) {
    return {
      x: image.height - crop.y - crop.height,
      y: crop.x,
      width: crop.height,
      height: crop.width,
    };
  }
  if (angle === 180) {
    return {
      x: image.width - crop.x - crop.width,
      y: image.height - crop.y - crop.height,
      width: crop.width,
      height: crop.height,
    };
  }
  if (angle === 270) {
    return {
      x: crop.y,
      y: image.width - crop.x - crop.width,
      width: crop.height,
      height: crop.width,
    };
  }
  return { ...crop };
}

/** 1 つの軸で、枠の始まりを置ける範囲 [下限, 上限]。枠は画像の内側に限る */
function axisRange(length: number, size: number): [number, number] {
  return [0, size - length];
}

/** 枠を小さくできる下限。元画像に対する割合で決め、画像の大小に付いていかせる */
const MIN_FRACTION = 0.1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 開いたときの枠（#146）。
 *
 * 見開きでなければ画像の全体。切り取る範囲の縦横比は自由で、2:3 に足りない
 * 分はサイドカーが余白で足すので、何も触らずに確定すれば画像を切らずに
 * 表紙にできる。
 *
 * 見開きは片側を選んで表紙にする絵なので、画像に収まる最大の 2:3 を中央に
 * 置く。viewer が描く中央クロップと同じ見え方になる。
 */
export function defaultCrop(image: ImageSize): CropRect {
  if (image.width / image.height < SPREAD_RATIO) {
    return { x: 0, y: 0, width: image.width, height: image.height };
  }
  const width = Math.min(image.width, image.height * TARGET_RATIO);
  const height = width / TARGET_RATIO;
  return {
    x: (image.width - width) / 2,
    y: (image.height - height) / 2,
    width,
    height,
  };
}

/** 元画像に施した加工 1 つ分。サイドカーが記録している形をそのまま受ける */
export type Operation = {
  kind: string;
  params?: { [key: string]: unknown };
};

/** 前回の加工から復元した、枠と向き */
export type RestoredEdit = { crop: CropRect; angle: QuarterTurn };

/**
 * 数の並びを読む。壊れていれば null。
 *
 * 数へ変換してから確かめると、null や "" や真偽値が 0 や 1 として通る。
 * 記録には無い「左上から 400×600」や 1px の枠が前回の範囲として出てしまい、
 * 利用者からは枠が消えたようにしか見えない。数そのものだけを受ける。
 */
function numbers(value: unknown, count: number): number[] | null {
  if (!Array.isArray(value) || value.length !== count) return null;
  const isRealNumber = (item: unknown) =>
    typeof item === "number" && Number.isFinite(item);
  return value.every(isRealNumber) ? (value as number[]) : null;
}

/** 90 度単位の回転だけを受ける。それ以外は枠に写せない */
function turnOf(value: unknown): QuarterTurn | null {
  const degrees = Number(value);
  if (!Number.isFinite(degrees)) return null;
  const normalised = ((degrees % 360) + 360) % 360;
  return normalised % 90 === 0 ? (normalised as QuarterTurn) : null;
}

/**
 * 加工 1 つが、加工前の絵のどこを取るか。取らないもの（回転）は null。
 *
 * shown は、その加工を受ける時点で出来ている絵の寸法。
 */
function takenRegion(operation: Operation, shown: ImageSize): CropRect | null {
  const params = operation.params ?? {};
  if (operation.kind === "crop") {
    const box = numbers(params.box, 4);
    if (!box) return null;
    const [left, upper, right, lower] = box;
    if (right <= left || lower <= upper) return null;
    // 記録は ZIP の中にあり、本を配る側が自由に書ける。画像からはみ出す
    // 範囲を枠に写すと、掴めない枠が出たうえ、そのまま確定すれば見当違いの
    // 範囲で本文が上書きされる。収めるのではなく受け付けない。収めた枠は
    // 「前回の範囲」として出るのに、前回の範囲ではない。
    // 画像の外まで広げた以前の記録（#130 #141）も、ここで既定の枠へ戻る
    if (!withinImage([left, upper, right, lower], shown)) return null;
    return { x: left, y: upper, width: right - left, height: lower - upper };
  }
  if (operation.kind === "split") {
    // 記録の座標系がいま見ている絵と食い違うなら描かない。ずれたまま枠を
    // 置くと、利用者は自分が選んでいない範囲を前回の範囲として見せられ、
    // そのまま確定すれば別の場所が切り出される。切り抜きの枠と同じ構え
    if (typeof params.width === "number" && params.width !== shown.width) {
      return null;
    }
    // #58 より前に書かれた本の記録には位置が無い。そちらは今までどおり
    // サイドカーと同じ既定（中央）に落とす
    const at =
      typeof params.x === "number" && Number.isFinite(params.x)
        ? params.x
        : Math.floor(shown.width / 2);
    if (at <= 0 || at >= shown.width) return null;
    // 右綴じなので、先に読む右半分が割った位置から右端まで
    if (params.side === "left") {
      return { x: 0, y: 0, width: at, height: shown.height };
    }
    if (params.side === "right") {
      return { x: at, y: 0, width: shown.width - at, height: shown.height };
    }
  }
  return null;
}

/**
 * 範囲 (left, upper, right, lower) が画像の内側にあるか。整数へ丸めた範囲の
 * ために 1 画素だけ許す。
 */
function withinImage(
  [left, upper, right, lower]: number[],
  image: ImageSize,
): boolean {
  return (
    left >= -1 &&
    upper >= -1 &&
    right <= image.width + 1 &&
    lower <= image.height + 1
  );
}

/**
 * 元画像に施した加工の並びから、前回選んだ範囲と向きを復元する。
 *
 * 記録は「元画像に対して、この順で加工した」という並びなので、逆から解かずに
 * 順に辿る。辿りながら「いま出来ている絵が元画像のどこか（region）」と
 * 「どちらを向いているか（angle）」を持てば、最後に残った region がそのまま
 * 前回の枠になる。
 *
 * 読めない記録が混ざったら、そこで諦めて null を返す。中途半端に解いた枠は、
 * 利用者から見ると前回の範囲と区別が付かない。
 *
 * 範囲を選ぶ加工が 1 つも無いとき（回転だけ、あるいは空）は、触っていない
 * ときと同じ既定の枠を返す。
 */
export function restoredEdit(
  operations: Operation[],
  original: ImageSize,
): RestoredEdit | null {
  let angle: QuarterTurn = 0;
  let chosen = false;
  let region: CropRect = {
    x: 0,
    y: 0,
    width: original.width,
    height: original.height,
  };
  for (const operation of operations) {
    if (operation.kind === "rotate") {
      const degrees = turnOf(operation.params?.degrees);
      if (degrees === null) return null;
      angle = ((angle + degrees) % 360) as QuarterTurn;
      continue;
    }
    // その時点の絵は region を angle だけ回したもの。範囲もその座標で書かれている
    const shown = rotatedSize(region, angle);
    const taken = takenRegion(operation, shown);
    if (!taken) return null;
    // 回す前へ戻してから元画像の座標へ足す。回転を挟んでも位置がずれない
    const upright = rotateCrop(taken, shown, oppositeTurn(angle));
    region = {
      x: region.x + upright.x,
      y: region.y + upright.y,
      width: upright.width,
      height: upright.height,
    };
    chosen = true;
  }
  if (region.width <= 0 || region.height <= 0) return null;
  if (!chosen) {
    // 回転だけの記録でも angle は返す。null を返すと向きまで落ち、
    // 開き直しただけで前回の向きが失われる
    return { crop: defaultCrop(rotatedSize(original, angle)), angle };
  }
  // 画面は回した後の座標で枠を持つ。元画像の座標から、その向きへ移して返す
  return { crop: rotateCrop(region, original, angle), angle };
}

/** 枠を、画像に収めたまま (x, y) へ置く */
function placedCrop(
  x: number,
  y: number,
  width: number,
  height: number,
  image: ImageSize,
): CropRect {
  const [left, right] = axisRange(width, image.width);
  const [top, bottom] = axisRange(height, image.height);
  return { x: clamp(x, left, right), y: clamp(y, top, bottom), width, height };
}

/** 枠を画像に収めたまま動かす */
function movedCrop(start: CropRect, dx: number, dy: number, image: ImageSize) {
  return placedCrop(
    start.x + dx,
    start.y + dy,
    start.width,
    start.height,
    image,
  );
}

type ResizeHandle = "n" | "s" | "w" | "e" | "nw" | "ne" | "sw" | "se";

/** 掴んだ辺・角だけを動かし、反対側を固定する。縦横比は自由で、画像の内側に収める */
function resizedCrop(
  start: CropRect,
  dx: number,
  dy: number,
  image: ImageSize,
  handle: ResizeHandle,
) {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  const minWidth = Math.min(start.width, image.width * MIN_FRACTION);
  const minHeight = Math.min(start.height, image.height * MIN_FRACTION);
  if (handle.includes("w")) left = clamp(left + dx, 0, right - minWidth);
  if (handle.includes("e"))
    right = clamp(right + dx, left + minWidth, image.width);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - minHeight);
  if (handle.includes("s"))
    bottom = clamp(bottom + dy, top + minHeight, image.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 1 つの軸の範囲を、画像の内側の整数へ丸める。
 *
 * 始まりと長さを別々に丸める。両端を丸めると長さが 1 画素ずれ、中央の 2:3 の
 * ような枠でもサイドカーが 1 画素の余白を足してしまう。
 */
function roundedAxis(
  start: number,
  length: number,
  size: number,
): [number, number] {
  const span = clamp(Math.round(length), 1, size);
  const first = clamp(Math.round(start), 0, size - span);
  return [first, first + span];
}

/**
 * 枠を、サイドカーが受け取る元画像の画素座標 (left, upper, right, lower) に直す。
 *
 * 枠も同じ単位で持っているので、ここでは端数を落とすだけ。表示上の座標を
 * そのまま送ると、縮小されたぶんだけ違う範囲が切られる。
 */
export function toCropBox(
  crop: CropRect,
  image: ImageSize,
): [number, number, number, number] {
  const [left, right] = roundedAxis(crop.x, crop.width, image.width);
  const [upper, lower] = roundedAxis(crop.y, crop.height, image.height);
  return [left, upper, right, lower];
}

type CropFrameProps = {
  image: ImageSize;
  src: string;
  angle: QuarterTurn;
  crop: CropRect;
  onChange: (crop: CropRect) => void;
};

const HANDLES: { edge: ResizeHandle; position: string; cursor: string }[] = [
  {
    edge: "n",
    position: "-top-0.5 right-3.5 left-3.5 h-3",
    cursor: "cursor-ns-resize",
  },
  {
    edge: "s",
    position: "-bottom-0.5 right-3.5 left-3.5 h-3",
    cursor: "cursor-ns-resize",
  },
  {
    edge: "w",
    position: "-left-0.5 top-3.5 bottom-3.5 w-3",
    cursor: "cursor-ew-resize",
  },
  {
    edge: "e",
    position: "-right-0.5 top-3.5 bottom-3.5 w-3",
    cursor: "cursor-ew-resize",
  },
  {
    edge: "nw",
    position: "-top-0.5 -left-0.5 size-4",
    cursor: "cursor-nwse-resize",
  },
  {
    edge: "ne",
    position: "-top-0.5 -right-0.5 size-4",
    cursor: "cursor-nesw-resize",
  },
  {
    edge: "sw",
    position: "-bottom-0.5 -left-0.5 size-4",
    cursor: "cursor-nesw-resize",
  },
  {
    edge: "se",
    position: "-bottom-0.5 -right-0.5 size-4",
    cursor: "cursor-nwse-resize",
  },
];
const LOUPE_SIZE = 144;

/** 枠は元画像の画素で持ち、描画だけを割合に直す。拡大表示も同じ座標・回転を使う */
export function CropFrame({
  image,
  src,
  angle,
  crop,
  onChange,
}: CropFrameProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    width: number;
    height: number;
  } | null>(null);
  const dragRef = useRef<{
    handle: ResizeHandle | "move";
    lastX: number;
    lastY: number;
    pointX: number;
    pointY: number;
    dx: number;
    dy: number;
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

  const magnify = (event: ReactPointerEvent, x: number, y: number) => {
    const box = rootRef.current!.getBoundingClientRect();
    setFocus({
      x: clamp((x / image.width) * box.width, 0, box.width),
      y: clamp((y / image.height) * box.height, 0, box.height),
      clientX: event.clientX,
      clientY: event.clientY,
      width: box.width,
      height: box.height,
    });
  };

  const beginDrag = (
    event: ReactPointerEvent,
    handle: ResizeHandle | "move",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    // 掴んだ要素へ以後の動きを寄せる。枠の外へ出ても追随させたい
    event.currentTarget.setPointerCapture(event.pointerId);
    const box = rootRef.current!.getBoundingClientRect();
    const point = toImagePixels(
      event.clientX - box.left,
      event.clientY - box.top,
    );
    dragRef.current = {
      handle,
      lastX: event.clientX,
      lastY: event.clientY,
      pointX: point.dx,
      pointY: point.dy,
      dx: 0,
      dy: 0,
      start: crop,
    };
    magnify(event, point.dx, point.dy);
  };

  const continueDrag = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 移動ごとに速度を適用する。途中で Shift を押す・離す場合も枠が飛ばない。
    const speed = event.shiftKey ? 0.1 : 1;
    const moved = toImagePixels(
      (event.clientX - drag.lastX) * speed,
      (event.clientY - drag.lastY) * speed,
    );
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.dx += moved.dx;
    drag.dy += moved.dy;
    const next =
      drag.handle === "move"
        ? movedCrop(drag.start, drag.dx, drag.dy, image)
        : resizedCrop(drag.start, drag.dx, drag.dy, image, drag.handle);
    onChange(next);
    // 微調整中も、カーソルの下の拡大鏡には実際に動かした辺を映す。
    const dx =
      drag.handle === "move" || drag.handle.includes("w")
        ? next.x - drag.start.x
        : drag.handle.includes("e")
          ? next.x + next.width - drag.start.x - drag.start.width
          : drag.dx;
    const dy =
      drag.handle === "move" || drag.handle.includes("n")
        ? next.y - drag.start.y
        : drag.handle.includes("s")
          ? next.y + next.height - drag.start.y - drag.start.height
          : drag.dy;
    magnify(event, drag.pointX + dx, drag.pointY + dy);
  };

  const endDrag = () => {
    dragRef.current = null;
    setFocus(null);
  };

  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  const upright = focus && rotatedSize(focus, angle);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0">
      <div
        data-testid="crop-frame"
        className="pointer-events-auto absolute touch-none cursor-move border-2 border-brand bg-brand/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
        style={{
          left: percent(crop.x, image.width),
          top: percent(crop.y, image.height),
          width: percent(crop.width, image.width),
          height: percent(crop.height, image.height),
        }}
        onPointerDown={(event) => beginDrag(event, "move")}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        {/* 掴む所は枠の内側に置く。はみ出させると画像の縁で切り取られ、掴めなくなる */}
        {HANDLES.map(({ edge, position, cursor }) => (
          <span
            key={edge}
            data-testid={edge === "se" ? "crop-handle" : `crop-handle-${edge}`}
            data-crop-handle={edge}
            aria-hidden
            className={`absolute flex items-center justify-center ${position} ${cursor}`}
            onPointerDown={(event) => beginDrag(event, edge)}
          >
            <span className="size-2.5 rounded-full border border-white bg-brand" />
          </span>
        ))}
      </div>
      {/* 画像の端でも切れないよう、ダイアログの外に描画する。入力は枠へ通す。 */}
      {focus && upright
        ? createPortal(
            <div
              data-testid="crop-loupe"
              aria-hidden
              className="pointer-events-none fixed z-[60] overflow-hidden rounded border-2 border-white bg-canvas shadow-lg"
              style={{
                width: LOUPE_SIZE + 4,
                height: LOUPE_SIZE + 4,
                left: clamp(
                  focus.clientX - (LOUPE_SIZE + 4) / 2,
                  8,
                  window.innerWidth - LOUPE_SIZE - 12,
                ),
                top: clamp(
                  focus.clientY - (LOUPE_SIZE + 4) / 2,
                  8,
                  window.innerHeight - LOUPE_SIZE - 12,
                ),
              }}
            >
              <svg
                role="img"
                aria-label="調整箇所を2倍で表示"
                className="h-full w-full"
                viewBox={`${focus.x - LOUPE_SIZE / 4} ${focus.y - LOUPE_SIZE / 4} ${LOUPE_SIZE / 2} ${LOUPE_SIZE / 2}`}
              >
                <image
                  href={src}
                  x={(focus.width - upright.width) / 2}
                  y={(focus.height - upright.height) / 2}
                  width={upright.width}
                  height={upright.height}
                  transform={`rotate(${angle} ${focus.width / 2} ${focus.height / 2})`}
                />
                <rect
                  x={(crop.x / image.width) * focus.width}
                  y={(crop.y / image.height) * focus.height}
                  width={(crop.width / image.width) * focus.width}
                  height={(crop.height / image.height) * focus.height}
                  className="fill-none stroke-brand"
                  strokeWidth="1"
                />
                <path
                  d={`M ${focus.x - 4} ${focus.y} h 8 M ${focus.x} ${focus.y - 4} v 8`}
                  stroke="white"
                  strokeWidth="0.5"
                />
              </svg>
              <span className="absolute right-1 bottom-1 rounded bg-canvas/80 px-1 text-[11px] text-ink">
                2×
              </span>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
