import { defineConfig } from "@playwright/test";

/**
 * Tauri は WebView にこの dev server の内容を読み込む。同じものを
 * ブラウザで駆動することで、コンテナ内でも UI の動作を検証できる。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
