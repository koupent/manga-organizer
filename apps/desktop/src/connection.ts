import type { SidecarConnection } from "./api/client";

/** Tauri の中で動いているか */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/**
 * サイドカーへの接続情報を得る。
 *
 * Tauri では Rust 側が起動したサイドカーの情報をコマンド経由で受け取る。
 * ブラウザ（開発と Playwright での検証）ではクエリ文字列から受け取る。
 * 同じ画面が両方で動くよう、ここだけを差し替える。
 */
export async function resolveConnection(): Promise<SidecarConnection | null> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const connection = await invoke<{ base_url: string; token: string }>(
      "sidecar_connection",
    );
    return { baseUrl: connection.base_url, token: connection.token };
  }

  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (!token) return null;
  // api を省いた場合は同一オリジン。dev server が /api をサイドカーへ
  // 中継するので、ブラウザから見えるポートは 1 つで済む
  const baseUrl = params.get("api") ?? window.location.origin;
  return { baseUrl, token };
}

/**
 * ドロップされた 1 件。
 *
 * フォルダかファイルかは実パスの文字列からは決まらないため、実在を見た
 * ネイティブ側の判断をそのまま受け取る。`is_dir` の綴りは Rust が出すまま。
 */
export type DroppedEntry = {
  path: string;
  is_dir: boolean;
};

/** ドロップされた 1 件として読めるか */
function isDroppedEntry(value: unknown): value is DroppedEntry {
  if (typeof value !== "object" || value === null) return false;
  if (!("path" in value) || !("is_dir" in value)) return false;
  return typeof value.path === "string" && typeof value.is_dir === "boolean";
}

/** 配列として読めるか。中身が何であるかはここでは見ない */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * イベントで届いた値を、ドロップされた一覧として読む。読めなければ null。
 *
 * ネイティブ側の綴りは、画面側が手で書いた型と機械的には結び付いていない。
 * 片方だけ変えても双方のコンパイラは何も言わず、そのまま `undefined` を
 * 触って落ちる。届いた値そのものをここで見て、読めないなら渡さない。
 */
function readDroppedEntries(payload: unknown): DroppedEntry[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!("entries" in payload)) return null;
  const entries = payload.entries;
  if (!isUnknownArray(entries)) return null;
  if (!entries.every(isDroppedEntry)) return null;
  return [...entries];
}

/**
 * 読めなかったときに画面へ出す理由。
 *
 * 空の一覧に丸めて黙ると「落としても何も起きない」だけが残り、利用者は
 * 落とし方が悪いのだと思い込む。何が起きたかと、いま通れる道を言う。
 */
const UNREADABLE_DROP =
  "ドロップされたものを受け取れませんでした（アプリ内部の受け渡しの形が" +
  "想定と違います）。「ファイルを選ぶ」から辿って指定してください。";

/**
 * エクスプローラーからのドロップを受ける。
 *
 * ブラウザはドロップされたファイルの実パスを取得できないため、Tauri の
 * ネイティブ側で受けてイベントで渡してもらう。ブラウザでは何もしない。
 *
 * 中身を確かめ終えてから `handler` を呼ぶ。途中まで進んでから落ちると、
 * 画面だけ切り替わって入力が増えないような中途半端な状態が残る。
 */
export async function onFilesDropped(
  handler: (entries: DroppedEntry[]) => void,
  onProblem: (reason: string) => void,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<unknown>("files-dropped", (event) => {
    const entries = readDroppedEntries(event.payload);
    if (!entries) {
      onProblem(UNREADABLE_DROP);
      return;
    }
    handler(entries);
  });
  return unlisten;
}
