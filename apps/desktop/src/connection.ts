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

/**
 * エクスプローラーからのドロップを受ける。
 *
 * ブラウザはドロップされたファイルの実パスを取得できないため、Tauri の
 * ネイティブ側で受けてイベントで渡してもらう。ブラウザでは何もしない。
 */
export async function onFilesDropped(
  handler: (entries: DroppedEntry[]) => void,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<{ entries: DroppedEntry[] }>(
    "files-dropped",
    (event) => {
      handler(event.payload.entries);
    },
  );
  return unlisten;
}
