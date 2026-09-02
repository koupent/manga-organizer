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
    await expect(page.getByTestId("selected-item")).toHaveAttribute(
      "data-path",
      archive,
    );
  });

  test("複数まとめて落とせる", async ({ page }) => {
    // Arrange
    const names = ["まとめて A.zip", "まとめて B.zip", "まとめて C.zip"];
    const dropped = names.map((name) => ({
      name,
      size: readFileSync(
        writeArchive(sidecar.workDir, name, [{ name: "001.jpg", color: "#00ff00" }]),
      ).length,
    }));
    await openOrganize(page);

    // Act
    await dropFiles(page, dropped);

    // Assert
    await expect(page.getByTestId("selected-count")).toHaveText("3 件");
  });

  test("落としたものを推定まで通せる", async ({ page }) => {
    // Arrange
    const names = ["通し作品 第01巻.zip", "通し作品 第02巻.zip"];
    const dropped = names.map((name) => ({
      name,
      size: readFileSync(
        writeArchive(sidecar.workDir, name, [{ name: "001.jpg", color: "#0000ff" }]),
      ).length,
    }));
    await openOrganize(page);

    // Act
    await dropFiles(page, dropped);
    await page.getByTestId("estimate").click();

    // Assert - 落としただけで推定まで進める
    const group = page.getByTestId("series-group").first();
    await expect(group).toHaveAttribute("data-title", "通し作品");
    await expect(group.getByTestId("volume")).toHaveCount(2);
  });

  test("見つからないものは理由を示す", async ({ page }) => {
    await openOrganize(page);

    // Act - 許可された場所に無いファイル
    await dropFiles(page, [{ name: "どこにもない.zip", size: 42 }]);

    // Assert
    await expect(page.getByTestId("picker-error")).toContainText("見つかりません");
    await expect(page.getByTestId("selected-count")).toHaveText("0 件");
  });

  test("一覧から 1 件だけ外せる", async ({ page }) => {
    // Arrange
    const names = ["外す A.zip", "外す B.zip"];
    const dropped = names.map((name) => ({
      name,
      size: readFileSync(
        writeArchive(sidecar.workDir, name, [{ name: "001.jpg", color: "#ffff00" }]),
      ).length,
    }));
    await openOrganize(page);
    await dropFiles(page, dropped);
    await expect(page.getByTestId("selected-count")).toHaveText("2 件");

    // Act
    await page.getByTestId("selected-item").first().getByRole("button").click();

    // Assert
    await expect(page.getByTestId("selected-count")).toHaveText("1 件");
  });
});
