import { useEffect, useRef, useState } from "react";
import {
  TARGET_RATIO,
  rotatedSize,
  type CropRect,
  type ImageSize,
  type QuarterTurn,
} from "./CropFrame";

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

/**
 * viewer での見え方。保留中の切り抜きと回転を、その場で描いて見せる。
 *
 * 加工はファイルへ書かずに溜めるので、保存済みの画像を貼っただけでは
 * 枠を動かしても回しても見え方が変わらない。確定するまで結果が見えない
 * 画面では、確定してみるまで正しいかどうか分からない。
 *
 * サイドカーは 切り抜き → 回転 の順に適用する。枠は回した後の座標で
 * 持っているので、ここでは「原稿を回してから、枠の中を切り出す」という
 * 同じ結果になる順で描く。最後に viewer と同じ 2:3 の中央クロップで収める。
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
    const context = canvas.getContext("2d");
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
    // viewer と同じ置き方。短い辺を枠に合わせ、余った側は中央で切る
    const scale = Math.max(
      canvas.width / crop.width,
      canvas.height / crop.height,
    );
    context.translate(
      (canvas.width - crop.width * scale) / 2,
      (canvas.height - crop.height * scale) / 2,
    );
    context.scale(scale, scale);
    context.translate(-crop.x, -crop.y);
    turnContext(
      context,
      angle,
      rotatedSize({ width: imageWidth, height: imageHeight }, angle),
    );
    context.drawImage(source, 0, 0, imageWidth, imageHeight);
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
