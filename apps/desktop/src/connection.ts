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
  const baseUrl = params.get("api");
  const token = params.get("token");
  return baseUrl && token ? { baseUrl, token } : null;
}

/**
 * エクスプローラーからのドロップを受ける。
 *
 * ブラウザはドロップされたファイルの実パスを取得できないため、Tauri の
 * ネイティブ側で受けてイベントで渡してもらう。ブラウザでは何もしない。
 */
export async function onFilesDropped(
  handler: (paths: string[]) => void,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<{ paths: string[] }>("files-dropped", (event) => {
    handler(event.payload.paths);
  });
  return unlisten;
}
