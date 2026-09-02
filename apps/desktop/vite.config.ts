import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// サイドカーの待ち受け先。開発時は固定ポートで起動しておく
const sidecarPort = process.env.MANGA_API_PORT ?? "8765";
const sidecarTarget = `http://127.0.0.1:${sidecarPort}`;

// Tauri は開発時にこの dev server を WebView へ読み込む。
// 同じものを Playwright とホストのブラウザでも駆動する。
//
// API を同一オリジンへ寄せるのは、ポート転送を 1 つで済ませるため。
// 2 つ必要にすると、片方を転送し忘れただけで画面が動かない。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // Dev Container のワークスペースは 9p のバインドマウントで inotify が
    // 届かない。ポーリングにしないとファイルの変更を検知できない
    watch: { usePolling: true, interval: 300 },
    proxy: {
      "/api": { target: sidecarTarget, changeOrigin: false },
      "/openapi.json": { target: sidecarTarget, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
