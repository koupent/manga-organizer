import type { SidecarConnection } from "./api/client";

/**
 * サイドカーへの接続情報を得る。
 *
 * Tauri シェルは起動時にサイドカーの stdout から読み取った値を
 * `window.__MANGA_SIDECAR__` に載せる。ブラウザで開いた場合（開発と
 * Playwright での検証）はクエリ文字列から受け取る。
 */
export function resolveConnection(): SidecarConnection | null {
  const injected = (
    window as unknown as { __MANGA_SIDECAR__?: SidecarConnection }
  ).__MANGA_SIDECAR__;
  if (injected?.baseUrl && injected?.token) return injected;

  const params = new URLSearchParams(window.location.search);
  const baseUrl = params.get("api");
  const token = params.get("token");
  return baseUrl && token ? { baseUrl, token } : null;
}
