import { useEffect, useRef, useState } from "react";
import {
  TARGET_RATIO,
  rotatedSize,
  type CropRect,
  type ImageSize,
  type QuarterTurn,
} from "./CropFrame";

/** 縁の色を拾う帯の太さ。manga_core.cover_editor.EDGE_STRIP_FRACTION と同じ */
const EDGE_STRIP_FRACTION = 0.01;

type CoverPreviewProps = {
  /** 原稿の URL。加工前の 1 枚をそのまま指す */
  src: string;
  /** 原稿の寸法（元画像の画素） */
  image: ImageSize;
  /** 保留中の回転 */
  angle: QuarterTurn;
  /** 保留中の切り抜き。回した後の座標で受け取る */
  crop: CropRect;
  /** 見本の幅。高さは 2:3 から決まる */
  width: number;
};

/** キャンバスの原点を、時計回りに angle だけ回した座標系へ移す */
function turnContext(
  context: CanvasRenderingContext2D,
  angle: QuarterTurn,
  turned: ImageSize,
) {
  if (angle === 90) context.translate(turned.width, 0);
  if (angle === 180) context.translate(turned.width, turned.height);
  if (angle === 270) context.translate(0, turned.height);
  context.rotate((angle * Math.PI) / 180);
}

/** 帯の中の画素の、色ごとの中央値（#rrggbb） */
function medianColour(data: Uint8ClampedArray): string {
  const channel = (offset: number) => {
    const values: number[] = [];
    for (let at = offset; at < data.length; at += 4) values.push(data[at]);
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 0;
  };
  const hex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${hex(channel(0))}${hex(channel(1))}${hex(channel(2))}`;
}

/**
 * viewer での見え方。保留中の切り抜きと回転を、その場で描いて見せる。
 *
 * 加工はファイルへ書かずに溜めるので、保存済みの画像を貼っただけでは
 * 枠を動かしても回しても見え方が変わらない。確定するまで結果が見えない
 * 画面では、確定してみるまで正しいかどうか分からない。
 *
 * サイドカーは 切り抜き → 回転 → 余白を足して 2:3（#146）の順に作る。枠は
 * 回した後の座標で持っているので、ここでは「原稿を回してから、枠の中を
 * 切り出す」という同じ結果になる順で描き、2:3 の中央に収めて、足りない側を
 * 切り出した絵の縁の色で塗る。
 */
export function CoverPreview({
  src,
  image,
  angle,
  crop,
  width,
}: CoverPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const height = width / TARGET_RATIO;
  // 原稿の寸法は値で取り出しておく。呼び出し元は描画のたびに入れ物を
  // 作り直すので、入れ物のまま持つと中身が同じでも別物として扱われる
  const { width: imageWidth, height: imageHeight } = image;

  useEffect(() => {
    // 画面に貼らない Image で読む。document.images に混ざらないので、
    // 読み込みを待つ他の仕組みを巻き込まない
    const loading = new Image();
    // 余白の色を絵の縁から拾うため、画素を読める形で取り寄せる。サイドカーは
    // 画面の生まれ（Tauri・開発）を許しているので、別の生まれでも読める
    loading.crossOrigin = "anonymous";
    let live = true;
    // 前の絵は、もう別の 1 枚のもの。持ち越すと、新しい絵が届くまでの間
    // 「前のページの画素を、新しい寸法と枠で切った絵」を見え方として出す。
    // 読み込みに失敗したときは、その間違った見本が出たまま残る
    setSource(null);
    loading.onload = () => {
      if (live) setSource(loading);
    };
    loading.onerror = () => {
      if (live) setSource(null);
    };
    loading.src = src;
    return () => {
      live = false;
      // 用済みの読み込みを手放す。後から届いても描かせない
      loading.onload = null;
      loading.onerror = null;
      loading.src = "";
    };
  }, [src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;

    // 画面の画素密度に合わせて実画素を持つ。CSS 上の大きさは style で決める
    const density = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    // 描く絵が無い間は空にしておく。前の絵を残すと、それが今の 1 枚の
    // 見え方だと読めてしまう
    if (!source || crop.width <= 0 || crop.height <= 0) return;

    // 切り出した絵を、2:3 の中に収まる最大の大きさで真ん中に置く
    const scale = Math.min(
      canvas.width / crop.width,
      canvas.height / crop.height,
    );
    const placed = {
      x: (canvas.width - crop.width * scale) / 2,
      y: (canvas.height - crop.height * scale) / 2,
      width: crop.width * scale,
      height: crop.height * scale,
    };
    const turned = rotatedSize(
      { width: imageWidth, height: imageHeight },
      angle,
    );
    const drawPicture = () => {
      context.save();
      context.beginPath();
      context.rect(placed.x, placed.y, placed.width, placed.height);
      context.clip();
      context.translate(placed.x, placed.y);
      context.scale(scale, scale);
      context.translate(-crop.x, -crop.y);
      turnContext(context, angle, turned);
      context.drawImage(source, 0, 0, imageWidth, imageHeight);
      context.restore();
    };
    drawPicture();

    // 足りない側を、切り出した絵のその辺の縁の色で塗る（サイドカーと同じ
    // 塗り方）。帯は絵の下へ少し潜らせ、境目に細い線が見えないようにする
    const sideways = placed.width < canvas.width - 1;
    const upright = placed.height < canvas.height - 1;
    if (!sideways && !upright) return;
    let colours: [string, string];
    try {
      const strip = (x: number, y: number, w: number, h: number) =>
        medianColour(
          context.getImageData(
            Math.floor(x),
            Math.floor(y),
            Math.max(1, Math.round(w)),
            Math.max(1, Math.round(h)),
          ).data,
        );
      if (sideways) {
        const across = Math.max(1, placed.width * EDGE_STRIP_FRACTION);
        colours = [
          strip(placed.x, placed.y, across, placed.height),
          strip(
            placed.x + placed.width - across,
            placed.y,
            across,
            placed.height,
          ),
        ];
      } else {
        const across = Math.max(1, placed.height * EDGE_STRIP_FRACTION);
        colours = [
          strip(placed.x, placed.y, placed.width, across),
          strip(
            placed.x,
            placed.y + placed.height - across,
            placed.width,
            across,
          ),
        ];
      }
    } catch {
      // 画素を読めない（取り寄せが生まれの違いで弾かれた）。余白は塗らずに
      // 絵だけを見せる。見本が無くなるより、色が付かない方がまし
      return;
    }
    const tuck = 2;
    context.fillStyle = colours[0];
    if (sideways) {
      context.fillRect(0, 0, placed.x + tuck, canvas.height);
      context.fillStyle = colours[1];
      context.fillRect(
        placed.x + placed.width - tuck,
        0,
        canvas.width - placed.x - placed.width + tuck,
        canvas.height,
      );
    } else {
      context.fillRect(0, 0, canvas.width, placed.y + tuck);
      context.fillStyle = colours[1];
      context.fillRect(
        0,
        placed.y + placed.height - tuck,
        canvas.width,
        canvas.height - placed.y - placed.height + tuck,
      );
    }
    drawPicture();
  }, [
    source,
    imageWidth,
    imageHeight,
    angle,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    width,
    height,
  ]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="viewer での見え方"
      className="block size-full"
    />
  );
}
