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
    // 記録は ZIP の中にあり、本を配る側が自由に書ける。絵からはみ出す範囲を
    // 枠に写すと、掴めない枠が出たうえ、そのまま確定すれば見当違いの範囲で
    // 本文が上書きされる。収めるのではなく受け付けない。収めた枠は
    // 「前回の範囲」として出るのに、前回の範囲ではない
    if (left < 0 || upper < 0) return null;
    if (right > shown.width || lower > shown.height) return null;
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
 * 範囲を選ぶ加工が 1 つも無いとき（回転だけ、あるいは空）は、絵の全面ではなく
 * 触っていないときと同じ既定の 2:3 を返す。全面を枠にすると、開き直して
 * そのまま確定しただけで 2:3 でない絵が表紙になり、viewer で切られる。
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
