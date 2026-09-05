import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => sidecar?.stop());

/**
 * 実際のドロップを再現する。
 *
 * ブラウザは実パスを渡さないので、名前とサイズだけを持つ File を作って
 * drop イベントを投げる。アプリはその手がかりから実パスを引き当てる。
 */
async function dropFiles(page: Page, files: { name: string; size: number }[]) {
  await page.dispatchEvent('[data-testid="dropzone"]', "drop", {
    dataTransfer: await page.evaluateHandle((entries) => {
      const transfer = new DataTransfer();
      for (const entry of entries) {
        transfer.items.add(
          new File([new Uint8Array(entry.size)], entry.name, {
            type: "application/zip",
          }),
        );
      }
      return transfer;
    }, files),
  });
}

/**
 * 落としたものの行。
 *
 * 一覧は 3 階層になり（#70 第 3 段階）、落としたものは一番外側の行になる。
 * 中で見つかったアーカイブや出来上がる本も同じ testid で並ぶので、
 * 深さで絞り込む。
 */
function droppedRows(page: Page) {
  return page.locator('[data-testid="plan-row"][data-level="0"]');
}

async function openOrganize(page: Page) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(join(sidecar.workDir, "out"))}`,
  );
  await expect(page.getByTestId("dropzone")).toBeVisible();
}

test.describe("ドラッグ&ドロップでの読み込み", () => {
  test("落としたファイルが一覧に入る", async ({ page }) => {
    // Arrange
    const archive = writeArchive(sidecar.workDir, "落とす作品 第01巻.zip", [
      { name: "001.jpg", color: "#ff0000" },
    ]);
    const size = readFileSync(archive).length;
    await openOrganize(page);
    await expect(page.getByTestId("selected-count")).toHaveText("0 件");

    // Act
    await dropFiles(page, [{ name: "落とす作品 第01巻.zip", size }]);

    // Assert - 実パスが引き当てられている
    await expect(page.getByTestId("selected-count")).toHaveText("1 件");
    await expect(droppedRows(page)).toHaveAttribute("data-path", archive);
  });

  test("複数まとめて落とせる", async ({ page }) => {
    // Arrange
    const names = ["まとめて A.zip", "まとめて B.zip", "まとめて C.zip"];
    const dropped = names.map((name) => ({
      name,
      size: readFileSync(
        writeArchive(sidecar.workDir, name, [
          { name: "001.jpg", color: "#00ff00" },
        ]),
      ).length,
    }));
    await openOrganize(page);

    // Act
    await dropFiles(page, dropped);

    // Assert
    await expect(page.getByTestId("selected-count")).toHaveText("3 件");
  });

  test("落としたものがそのまま処理対象になる", async ({ page }) => {
    // Arrange
    const names = ["通し作品 第01巻.zip", "通し作品 第02巻.zip"];
    const dropped = names.map((name) => ({
      name,
      size: readFileSync(
        writeArchive(sidecar.workDir, name, [
          { name: "001.jpg", color: "#0000ff" },
        ]),
      ).length,
    }));
    await openOrganize(page);

    // Act
    await dropFiles(page, dropped);

    // Assert - 落とした順に一覧へ並ぶ
    await expect(page.getByTestId("selected-count")).toHaveText("2 件");
    const items = droppedRows(page);
    await expect(items.nth(0)).toHaveAttribute("data-path", /第01巻\.zip$/);
    await expect(items.nth(1)).toHaveAttribute("data-path", /第02巻\.zip$/);
  });

  test("見つからないものは理由を示す", async ({ page }) => {
    await openOrganize(page);

    // Act - 許可された場所に無いファイル
    await dropFiles(page, [{ name: "どこにもない.zip", size: 42 }]);

    // Assert
    await expect(page.getByTestId("picker-error")).toContainText(
      "見つかりません",
    );
    await expect(page.getByTestId("selected-count")).toHaveText("0 件");
  });

  test("file:// の URI が載っていればそのまま使う", async ({ page }) => {
    // Arrange - VS Code やファイルマネージャは text/uri-list に実パスを載せる
    const archive = writeArchive(sidecar.workDir, "URI 経由.zip", [
      { name: "001.jpg", color: "#00ffff" },
    ]);
    await openOrganize(page);

    // Act
    await page.dispatchEvent('[data-testid="dropzone"]', "drop", {
      dataTransfer: await page.evaluateHandle(
        (uri) => {
          const transfer = new DataTransfer();
          transfer.setData("text/uri-list", uri);
          return transfer;
        },
        `file://${encodeURI(archive)}`,
      ),
    });

    // Assert - 名前で探さずに直接使える
    await expect(page.getByTestId("selected-count")).toHaveText("1 件");
    await expect(droppedRows(page)).toHaveAttribute("data-path", archive);
  });

  test("見つからないときは探した場所を示す", async ({ page }) => {
    await openOrganize(page);
    await dropFiles(page, [{ name: "存在しない.zip", size: 7 }]);
    await expect(page.getByTestId("picker-error")).toContainText("探した場所");
    await expect(page.getByTestId("picker-error")).toContainText(
      sidecar.workDir,
    );
  });

  test("一覧から 1 件だけ外せる", async ({ page }) => {
    // Arrange
    const names = ["外す A.zip", "外す B.zip"];
    const dropped = names.map((name) => ({
      name,
      size: readFileSync(
        writeArchive(sidecar.workDir, name, [
          { name: "001.jpg", color: "#ffff00" },
        ]),
      ).length,
    }));
    await openOrganize(page);
    await dropFiles(page, dropped);
    await expect(page.getByTestId("selected-count")).toHaveText("2 件");

    // Act - 行にはチェックもあるので、外すボタンを直接指す
    await droppedRows(page).first().getByTestId("plan-remove").click();

    // Assert
    await expect(page.getByTestId("selected-count")).toHaveText("1 件");
  });
});
