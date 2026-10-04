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

/** 画像の 4 辺の縁の色（#rrggbb）。サイドカーが拾い、はみ出した所をこの色で塗る */
export type EdgeColors = {
  top: string;
  bottom: string;
  left: string;
  right: string;
};

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

/**
 * 縁の色を、画像を時計回りに angle だけ回した後の向きへ移す。
 *
 * サイドカーは回す前の画像で切り抜き、外へはみ出した所をその向きの辺の色で
 * 塗ってから回す。画面は回した後の絵の上で見本を描くので、辺も同じだけ回す。
 */
export function turnedEdges(edges: EdgeColors, angle: QuarterTurn): EdgeColors {
  if (angle === 90) {
    return {
      top: edges.left,
      right: edges.top,
      bottom: edges.right,
      left: edges.bottom,
    };
  }
  if (angle === 180) {
    return {
      top: edges.bottom,
      right: edges.left,
      bottom: edges.top,
      left: edges.right,
    };
  }
  if (angle === 270) {
    return {
      top: edges.right,
      right: edges.bottom,
      bottom: edges.left,
      left: edges.top,
    };
  }
  return { ...edges };
}

/**
 * 枠を置ける範囲（#130）。画像の座標で持ち、原点は画像の左上。
 *
 * 見開きでなければ、画像の全体がちょうど収まる 2:3 まで広げられる。2:3 に
 * 収まらない表紙を切らずに使うため。それより大きくしても余白が増えるだけなので、
 * 上限はここで 1 つに決まる。画像は範囲の真ん中に置く。枠はこの範囲の中なら
 * どこへでも動かせる（#141）。
 *
 * 見開きは片側を選んで表紙にする絵で、全体を収めると細い帯に余白ばかりが付く。
 * 余白のぶん場所を取ると選ぶための絵まで小さく出るので、画像の内側に限る。
 */
export function canvasOf(image: ImageSize): CropRect {
  if (image.width / image.height >= SPREAD_RATIO) {
    return { x: 0, y: 0, width: image.width, height: image.height };
  }
  const width = Math.max(image.width, image.height * TARGET_RATIO);
  const height = width / TARGET_RATIO;
  return {
    x: (image.width - width) / 2,
    y: (image.height - height) / 2,
    width,
    height,
  };
}

/**
 * 1 つの軸で、枠の始まりを置ける範囲 [下限, 上限]。
 *
 * 置ける範囲（from から span）の内側ならどこでもよい（#141）。以前は、片側を
 * 切りながら反対側に余白を足す枠を作らなかったが、画面には余白まで見えて
 * いるので、利用者には見えない壁で止められたようにしか見えなかった。
 * ただし画像とは 1 画素でも重ねる。重ならない枠は、塗っただけの表紙になる。
 */
function axisRange(
  length: number,
  size: number,
  from: number,
  span: number,
): [number, number] {
  return [Math.max(from, 1 - length), Math.min(from + span - length, size - 1)];
}

/** 枠を小さくできる下限。元画像に対する割合で決め、画像の大小に付いていかせる */
const MIN_WIDTH_FRACTION = 0.1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 開いたときの枠（#141）。
 *
 * 見開きでなければ、画像の全体が収まる 2:3（置ける範囲いっぱい）。表紙は
 * 画像を切らずに使うことがほとんどで、画像の内側の 2:3 から始めると、毎回
 * 広げ直す手間になる。何も触らずに確定すると、足りない所を縁の色で塗った
 * 表紙になる。
 *
 * 見開きは片側を選んで表紙にする絵なので、画像に収まる最大の 2:3 を中央に
 * 置く。viewer が描く中央クロップと同じ見え方になる。
 */
export function defaultCrop(image: ImageSize): CropRect {
  if (image.width / image.height < SPREAD_RATIO) return canvasOf(image);
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
    // 記録は ZIP の中にあり、本を配る側が自由に書ける。枠を置ける範囲から
    // はみ出す範囲を枠に写すと、掴めない枠が出たうえ、そのまま確定すれば
    // 見当違いの範囲で本文が上書きされる。収めるのではなく受け付けない。
    // 収めた枠は「前回の範囲」として出るのに、前回の範囲ではない
    if (!withinCanvas([left, upper, right, lower], shown)) return null;
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
 * 範囲 (left, upper, right, lower) が、枠を置ける範囲に収まっているか。
 *
 * 各軸で、置ける範囲の内側にあり、画像と重なっているか（#141）。置ける範囲の
 * 端は小数なので、整数へ丸めた範囲のために 1 画素だけ許す。
 */
function withinCanvas(
  [left, upper, right, lower]: number[],
  image: ImageSize,
): boolean {
  const canvas = canvasOf(image);
  const fits = (
    start: number,
    end: number,
    size: number,
    from: number,
    span: number,
  ) => start >= from - 1 && end <= from + span + 1 && end > 0 && start < size;
  return (
    fits(left, right, image.width, canvas.x, canvas.width) &&
    fits(upper, lower, image.height, canvas.y, canvas.height)
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

/** 枠を、置ける範囲に収めたまま (x, y) へ置く */
function placedCrop(
  x: number,
  y: number,
  width: number,
  image: ImageSize,
): CropRect {
  const canvas = canvasOf(image);
  const height = width / TARGET_RATIO;
  const [left, right] = axisRange(width, image.width, canvas.x, canvas.width);
  const [top, bottom] = axisRange(
    height,
    image.height,
    canvas.y,
    canvas.height,
  );
  return { x: clamp(x, left, right), y: clamp(y, top, bottom), width, height };
}

/** 枠を置ける範囲に収めたまま動かす */
function movedCrop(start: CropRect, dx: number, dy: number, image: ImageSize) {
  return placedCrop(start.x + dx, start.y + dy, start.width, image);
}

/**
 * 角を掴んで大きさを変える。縦横比は 2:3 のまま動かさない。
 *
 * 比率を固定するのは、viewer が表紙を 2:3 に切って描くため。自由な比率で
 * 切ると、画面で見た範囲と一覧での見え方がずれる。
 *
 * 縦横どちらへ動かしても効くよう、動きの大きい方の軸を寸法の手がかりにする。
 * 端に当たったら枠の方を寄せて、置ける範囲いっぱいまで広げられるようにする。
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
  const canvas = canvasOf(image);
  const width = clamp(
    requested,
    image.width * MIN_WIDTH_FRACTION,
    Math.min(canvas.width, canvas.height * TARGET_RATIO),
  );
  return placedCrop(start.x, start.y, width, image);
}

/**
 * 1 つの軸の範囲を整数へ丸める。丸めた後も画像と 1 画素は重ねる（サイドカーは
 * 画像と重ならない範囲を断る）。
 */
function roundedAxis(
  start: number,
  length: number,
  size: number,
): [number, number] {
  const first = Math.min(Math.round(start), size - 1);
  return [first, Math.max(Math.round(start + length), first + 1, 1)];
}

/**
 * 枠を、サイドカーが受け取る元画像の画素座標 (left, upper, right, lower) に直す。
 *
 * 枠も同じ単位で持っているので、ここでは端数を落とすだけ。表示上の座標を
 * そのまま送ると、縮小されたぶんだけ違う範囲が切られる。画像の外へ広げた枠は
 * そのまま外を指す（#130）。はみ出した所はサイドカーが縁の色で塗る。
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
  crop: CropRect;
  onChange: (crop: CropRect) => void;
};

/**
 * 表示中の画像に重ねる 2:3 の切り抜き枠。
 *
 * 枠は元画像の画素で持ち、描画だけを割合に直す。表示は縮小されているので、
 * 画面上の座標のまま持つと、そのまま送ったときに意図しない範囲が切られる。
 *
 * 重ねる先は画像ではなく、枠を置ける範囲（canvasOf）。画像の外まで広げた枠も
 * 描けるように、呼び出し側はその範囲を画面に並べ、この部品を全面に重ねる。
 */
export function CropFrame({ image, crop, onChange }: CropFrameProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    resize: boolean;
    originX: number;
    originY: number;
    start: CropRect;
  } | null>(null);

  const canvas = canvasOf(image);

  /** 画面上の移動量を元画像の画素へ直す。縮小率は実際の描画から測る */
  const toImagePixels = (dx: number, dy: number) => {
    const box = rootRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { dx: 0, dy: 0 };
    return {
      dx: (dx * canvas.width) / box.width,
      dy: (dy * canvas.height) / box.height,
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
          left: percent(crop.x - canvas.x, canvas.width),
          top: percent(crop.y - canvas.y, canvas.height),
          width: percent(crop.width, canvas.width),
          height: percent(crop.height, canvas.height),
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
