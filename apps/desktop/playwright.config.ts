import { defineConfig } from "@playwright/test";

/**
 * Tauri は WebView にビルド済みのフロントエンドを読み込む。同じものを
 * ブラウザで駆動することで、コンテナ内でも UI の動作を検証できる。
 */

// 既定はビルドしてから preview で配信する。dev server を再利用すると、
// 何時間も前から動いていたサーバーが古いコードを返し、E2E の結果が
// 「たまたま動いていたサーバーの鮮度」で変わる。実際に配布するものを
// 毎回作り直して検証すれば、その余地が原理的に無くなる。
//
// E2E_DEV_SERVER=1 のときだけ dev server（5173）を再利用する。
// 手元でビルドを待たずに素早く回すための逃げ道であり、
// scripts/run_merge_gate.sh では使わない。
const useDevServer = process.env.E2E_DEV_SERVER === "1";

const baseURL = useDevServer
  ? "http://127.0.0.1:5173"
  : "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: useDevServer ? "npm run dev" : "npm run build && npm run preview",
    url: baseURL,
    reuseExistingServer: useDevServer,
    // ビルドを挟むぶん dev server より立ち上がりが遅い
    timeout: useDevServer ? 60_000 : 180_000,
  },
});
