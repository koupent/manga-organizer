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

  useEffect(() => {
    // 画面に貼らない Image で読む。document.images に混ざらないので、
    // 読み込みを待つ他の仕組みを巻き込まない
    const loading = new Image();
    let live = true;
    loading.onload = () => {
      if (live) setSource(loading);
    };
    loading.src = src;
    return () => {
      live = false;
    };
  }, [src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    const context = canvas.getContext("2d");
    if (!context || crop.width <= 0 || crop.height <= 0) return;

    // 画面の画素密度に合わせて実画素を持つ。CSS 上の大きさは style で決める
    const density = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
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
    turnContext(context, angle, rotatedSize(image, angle));
    context.drawImage(source, 0, 0, image.width, image.height);
    // 依存は値そのもので並べる。呼び出し元が毎回作り直す入れ物の同一性で
    // 描き直すと、何も変わっていない描画を繰り返すことになる
  }, [
    source,
    image.width,
    image.height,
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
