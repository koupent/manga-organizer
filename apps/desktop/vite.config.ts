import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// サイドカーの待ち受け先。開発時は固定ポートで起動しておく
const sidecarPort = process.env.MANGA_API_PORT ?? "8765";
const sidecarTarget = `http://127.0.0.1:${sidecarPort}`;

// API を同一オリジンへ寄せるのは、ポート転送を 1 つで済ませるため。
// 2 つ必要にすると、片方を転送し忘れただけで画面が動かない。
//
// preview は server の設定を引き継がないため、同じ内容をどちらにも渡す。
// 定義を 1 つにしておかないと、片方だけ直して食い違うことになる。
const proxy = {
  "/api": { target: sidecarTarget, changeOrigin: false },
  "/openapi.json": { target: sidecarTarget, changeOrigin: false },
};

// Tauri は開発時にこの dev server を WebView へ読み込む。
// 同じものをホストのブラウザでも駆動する。
//
// E2E は dev server ではなく preview（ビルド済みの dist）を見る。
// dev server を使うと、たまたま動いていた古いサーバーを再利用して
// 実際のソースと違うものを検証してしまう。ポートを 5173 と分けるのは、
// 手動確認用の dev server と E2E を同時に動かせるようにするため。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // Dev Container のワークスペースは 9p のバインドマウントで inotify が
    // 届かない。ポーリングにしないとファイルの変更を検知できない
    watch: { usePolling: true, interval: 300 },
    proxy,
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    proxy,
  },
  build: { outDir: "dist", emptyOutDir: true },
});
