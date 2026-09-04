import { useCallback, useRef, useState } from "react";

/** 幅と高さ。単位は CSS 画素 */
export type Size = { width: number; height: number };

/**
 * 枠に収まる最大の大きさを、縦横比を保ったまま返す。
 *
 * 「高さいっぱい、ただし幅も溢れない」を CSS の入れ子だけで書くと、横長の絵で
 * 縦横比が崩れる。高さが確定した箱に max-width を足しても、はみ出したぶんだけ
 * 潰れるだけで、高さは戻らないため。表示の大きさはここで決め、CSS には
 * 結果の寸法だけを渡す。
 *
 * 拡大も許す。この画面で判断するのは絵そのものであり、枠を掴んで動かすにも
 * 面積が要る。切り抜きの範囲は元画像の画素で持っているので、表示を拡大しても
 * 送る値と出来上がりの画質は変わらない。
 */
export function fitInside(image: Size, box: Size): Size {
  if (image.width <= 0 || image.height <= 0) return { width: 0, height: 0 };
  if (box.width <= 0 || box.height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(box.width / image.width, box.height / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

/**
 * 要素の内寸を測り、変わるたびに知らせる。
 *
 * 返すのは ref そのものではなくコールバック ref。要素が現れた時点と消えた時点が
 * そのまま分かるので、条件付きで描かれる要素でも測り始めを取りこぼさない。
 * 初回は描画の前に測るため、大きさ 0 の絵が一瞬映ることもない。
 */
export function useBoxSize<T extends HTMLElement>(): [
  (node: T | null) => void,
  Size,
] {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    // 枠線と余白を除いた中身の寸法。絵を置ける面はここまで
    const measure = () =>
      setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
  }, []);

  return [ref, size];
}
