import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri は開発時にこの dev server を WebView へ読み込む。
// 同じものを Playwright でも駆動するため、ホストとポートを固定する。
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
