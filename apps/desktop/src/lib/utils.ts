import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** クラス名を結合する。後勝ちで衝突を解決する */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 絵の URL に添える世代の初期値。部品を作るたびに違う値にする。
 *
 * 別の画面が本を書き換えると、この本を抱えた画面は作り直される。世代を 0 から
 * 数え直すと、作り直す前と同じ URL になり、ブラウザは覚えている古い絵を出す
 * （同じ文書の中の画像は、キャッシュの指示に関わらず使い回される）。名前は
 * 同じでも中身は別のページなので、利用者は書き換える前の並びを見せられる。
 */
export const firstImageGeneration = () => Date.now();
