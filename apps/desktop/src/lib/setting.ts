import { useCallback, useState } from "react";

/** 表示の好みを保存する場所。他の保存物と混ざらないよう接頭辞を付ける */
const PREFIX = "manga-organizer:";

/**
 * localStorage が使えないことは珍しくない。
 *
 * WebView の設定や、利用者が保存を切っている場合に読み書きが例外を投げる。
 * 表示の好みが残らないだけで画面は使えるので、ここで握って既定に倒す。
 * 握るのはこの 2 つの関数の中だけにして、呼び出す側では例外を考えない。
 */
function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // 保存できなくても、この画面を開いているあいだは値が効く
  }
}

/**
 * 数値の表示設定を、次に開いたときまで覚えておく。
 *
 * 値そのものは React の状態として持つ。置き場所（どの部品が描くか）を
 * 変えても、また部品が作り直されても同じ値に戻ってくるようにするため、
 * 保存と読み出しをこのフックの中だけに閉じ込める。
 *
 * 保存されていない値・数でない値は既定に倒す。localStorage の中身は
 * 前のバージョンが書いたものかもしれず、そのまま信じない。
 */
export function useStoredNumber(
  key: string,
  fallback: number,
): [number, (value: number) => void] {
  // 初回だけ読む。描画のたびに localStorage を触ると無駄に遅い
  const [value, setValue] = useState(() => {
    const stored = Number(readRaw(key));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  });

  const store = useCallback(
    (next: number) => {
      setValue(next);
      writeRaw(key, String(next));
    },
    [key],
  );

  return [value, store];
}
