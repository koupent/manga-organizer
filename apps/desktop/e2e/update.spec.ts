import { expect, test, type Page } from "@playwright/test";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 新しい版の知らせと、受け入れたときの入れ替え。
 *
 * 本物の更新は Tauri の中でしか起きない。ここでは Tauri の内部の口
 * （`window.__TAURI_INTERNALS__`）を偽物に差し替え、画面が updater プラグインを
 * どの順で呼ぶかを確かめる。いちばん大事なのは、インストーラを起こす前に
 * サイドカーを止めること。止めないと、インストーラが `manga-api.exe` を
 * 上書きできない。
 */

type Scenario = {
  /** check が返す更新。null なら「新しい版は無い」 */
  update: { version: string; body: string } | null;
  /** download を失敗させる理由。無ければ成功する */
  downloadError?: string;
};

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => sidecar?.stop());

/** Tauri の内部の口を偽物にし、呼ばれたコマンドを順に記録する */
async function openAsTauri(page: Page, scenario: Scenario) {
  await page.addInitScript(
    ({ scenario, connection }) => {
      const callbacks = new Map<number, (message: unknown) => void>();
      let nextId = 1;
      const calls: string[] = [];
      (window as unknown as { __updateCalls: string[] }).__updateCalls = calls;
      (
        window as unknown as { __TAURI_INTERNALS__: unknown }
      ).__TAURI_INTERNALS__ = {
        transformCallback(callback: (message: unknown) => void) {
          const id = nextId++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        async invoke(command: string, args: Record<string, unknown>) {
          calls.push(command);
          switch (command) {
            case "sidecar_connection":
              return connection;
            case "plugin:updater|check":
              return scenario.update
                ? {
                    rid: 1,
                    currentVersion: "4.1.0",
                    version: scenario.update.version,
                    date: "2026-10-04T00:00:00Z",
                    body: scenario.update.body,
                    rawJson: {},
                  }
                : null;
            case "plugin:updater|download": {
              if (scenario.downloadError) throw scenario.downloadError;
              const channel = args.onEvent as { id: number };
              const send = callbacks.get(channel.id);
              send?.({
                index: 0,
                message: { event: "Started", data: { contentLength: 100 } },
              });
              send?.({
                index: 1,
                message: { event: "Progress", data: { chunkLength: 100 } },
              });
              send?.({ index: 2, message: { event: "Finished" } });
              return 2;
            }
            default:
              return null;
          }
        },
      };
    },
    {
      scenario,
      connection: { base_url: sidecar.baseUrl, token: sidecar.token },
    },
  );
  await page.goto("/");
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "ok",
  );
}

const calls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __updateCalls: string[] }).__updateCalls,
  );

test("新しい版が無ければ何も出さない", async ({ page }) => {
  await openAsTauri(page, { update: null });

  await expect.poll(() => calls(page)).toContain("plugin:updater|check");
  await expect(page.getByTestId("update-notice")).toHaveCount(0);
});

test("新しい版があれば、版と変更点を出し、あとで を押せば消える", async ({
  page,
}) => {
  await openAsTauri(page, {
    update: { version: "4.2.0", body: "- 保存できない不具合を直した" },
  });

  const notice = page.getByTestId("update-notice");
  await expect(notice).toContainText("v4.2.0");
  await expect(notice).toContainText("保存できない不具合を直した");

  await notice.getByRole("button", { name: "あとで" }).click();
  await expect(notice).toHaveCount(0);
  expect(await calls(page)).not.toContain("plugin:updater|download");
});

test("更新するを押すと、落としてからサイドカーを止め、それからインストーラを起こす", async ({
  page,
}) => {
  await openAsTauri(page, { update: { version: "4.2.0", body: "" } });

  await page
    .getByTestId("update-notice")
    .getByRole("button", { name: "更新する" })
    .click();

  await expect
    .poll(async () =>
      (await calls(page)).filter((call) =>
        [
          "plugin:updater|download",
          "stop_sidecar",
          "plugin:updater|install",
        ].includes(call),
      ),
    )
    .toEqual([
      "plugin:updater|download",
      "stop_sidecar",
      "plugin:updater|install",
    ]);
});

test("落とせなかったら理由を出し、サイドカーは止めずインストーラも起こさない", async ({
  page,
}) => {
  await openAsTauri(page, {
    update: { version: "4.2.0", body: "" },
    downloadError: "ネットワークに届きません",
  });

  const notice = page.getByTestId("update-notice");
  await notice.getByRole("button", { name: "更新する" }).click();

  await expect(notice).toContainText("ネットワークに届きません");
  const made = await calls(page);
  expect(made).not.toContain("stop_sidecar");
  expect(made).not.toContain("plugin:updater|install");
  // 使い続けられる。サイドカーは生きている
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "ok",
  );
});

test.describe("設定から更新を確かめ直す（#136）", () => {
  test("あとで を押した後も、設定の「更新を確認」で案内を出し直せる", async ({
    page,
  }) => {
    // Arrange - 起動時の案内を閉じる
    await openAsTauri(page, {
      update: { version: "4.3.0", body: "- 結合できるようにした" },
    });
    const notice = page.getByTestId("update-notice");
    await notice.getByRole("button", { name: "あとで" }).click();
    await expect(notice).toHaveCount(0);

    // Act
    await page.getByTestId("open-settings").click();
    const dialog = page.getByTestId("settings-dialog");
    await expect(dialog.getByTestId("app-version")).toHaveText(
      /^v\d+\.\d+\.\d+$/,
    );
    await dialog.getByTestId("check-update").click();

    // Assert - 確かめ直して見つかったことを伝え、案内を出し直す
    await expect(dialog.getByTestId("update-check-status")).toHaveText(
      "新しい版 v4.3.0 があります。画面上部の案内から更新できます",
    );
    expect(
      (await calls(page)).filter((call) => call === "plugin:updater|check"),
    ).toHaveLength(2);
    await page.keyboard.press("Escape");
    await expect(notice).toContainText("v4.3.0");
  });

  test("新しい版が無ければ、最新の版だと伝える", async ({ page }) => {
    // Arrange
    await openAsTauri(page, { update: null });

    // Act
    await page.getByTestId("open-settings").click();
    await page.getByTestId("check-update").click();

    // Assert
    await expect(page.getByTestId("update-check-status")).toHaveText(
      "最新の版です",
    );
    await expect(page.getByTestId("update-notice")).toHaveCount(0);
  });

  test("ブラウザで開いているときは、確かめられないことを伝える", async ({
    page,
  }) => {
    // Arrange - Tauri の外（開発と e2e のふだんの開き方）
    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}`,
    );

    // Act
    await page.getByTestId("open-settings").click();

    // Assert
    await expect(page.getByTestId("check-update")).toBeDisabled();
    await expect(page.getByTestId("update-check-status")).toHaveText(
      "ブラウザで開いているときは確認できません",
    );
  });
});
