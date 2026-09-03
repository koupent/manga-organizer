import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** クラス名を結合する。後勝ちで衝突を解決する */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
