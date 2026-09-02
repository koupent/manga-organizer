import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

const CORE_DIR = fileURLToPath(new URL("../../../services/core", import.meta.url));

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => sidecar?.stop());

/** 出力先に生成されたファイルを列挙する */
function producedFiles(root: string): string[] {
  const output = execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      `
import sys
from pathlib import Path
root = Path(sys.argv[1])
if root.exists():
    for path in sorted(root.rglob("*")):
        if path.is_file():
            print(path.relative_to(root).as_posix())
`,
      root,
    ],
    { cwd: CORE_DIR, encoding: "utf8" },
  );
  return output.trim() ? output.trim().split("\n") : [];
}


/** ファイルブラウザから対象を選ぶ。実パスはサーバー側が返す */
async function selectArchives(
  page: import("@playwright/test").Page,
  paths: string[],
) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  for (const path of paths) {
    const name = path.split("/").pop()!;
    await page
      .locator(`[data-testid="browse-entry"][data-name="${name}"] .browser-name`)
      .click();
  }
  await expect(page.getByTestId("selected-count")).toHaveText(`${paths.length} 件`);
  await page.getByTestId("open-browser").click();
}

async function openOrganize(page: import("@playwright/test").Page, output: string) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

test.describe("整理画面", () => {
  test("推定結果を確認し、修正してから整理を実行できる", async ({ page }) => {
    // Arrange - 2 作品ぶんのアーカイブ
    const paths = [
      writeArchive(sidecar.workDir, "作品A 第01巻.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
      writeArchive(sidecar.workDir, "作品A 第02巻.zip", [
        { name: "001.jpg", color: "#00ff00" },
      ]),
      writeArchive(sidecar.workDir, "作品B 第01巻.zip", [
        { name: "001.jpg", color: "#0000ff" },
      ]),
    ];
    const output = join(sidecar.workDir, "out");
    mkdirSync(output, { recursive: true });

    await openOrganize(page, output);
    await selectArchives(page, paths);
    await page.getByTestId("estimate").click();

    // Assert - 作品ごとにまとまり、巻数と確信度が出る
    const groups = page.getByTestId("series-group");
    await expect(groups).toHaveCount(2);
    await expect(page.getByTestId("group-count")).toHaveText("2 作品");
    await expect(groups.nth(0)).toHaveAttribute("data-title", "作品A");
    await expect(groups.nth(0).getByTestId("volume")).toHaveCount(2);
    await expect(groups.nth(0).getByTestId("confidence")).toHaveText("推定 高");

    // Act - 作品名を直す（自動推定は外れる前提）
    await groups.nth(0).getByTestId("group-title").fill("ワンピース");

    // Act - 整理を実行
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText("整理しました", {
      timeout: 30_000,
    });

    // Assert - 直した名前で出力される
    const produced = producedFiles(output);
    expect(produced.some((path) => path.includes("ワンピース"))).toBeTruthy();
    expect(produced.some((path) => path.includes("作品B"))).toBeTruthy();
    expect(produced.every((path) => path.endsWith(".zip"))).toBeTruthy();
  });

  test("著者を入力して整理すると、出力名に反映され辞書に残る", async ({ page }) => {
    // Arrange
    const paths = [
      writeArchive(sidecar.workDir, "著者テスト 第01巻.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
    ];
    const output = join(sidecar.workDir, "out5");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await selectArchives(page, paths);
    await page.getByTestId("estimate").click();

    const group = page.getByTestId("series-group").first();
    await expect(group.getByTestId("volume")).toHaveCount(1);

    // Act - 著者を入れて整理する
    await group.getByTestId("group-author").fill("テスト著者");
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText("整理しました", {
      timeout: 30_000,
    });

    // Assert - 出力パスに著者名が入る
    const produced = producedFiles(output);
    expect(produced.some((path) => path.includes("テスト著者"))).toBeTruthy();

    // Assert - 辞書に残り、次回以降に使える
    const entries = await page.evaluate(
      async ([base, token]) => {
        const response = await fetch(
          `${base}/api/library/entries?token=${token}`,
        );
        return response.json();
      },
      [sidecar.baseUrl, sidecar.token],
    );
    expect(
      entries.entries.some(
        (entry: { title: string; author: string }) =>
          entry.author === "テスト著者",
      ),
    ).toBeTruthy();
  });

  test("1 冊を別の作品へ移せる", async ({ page }) => {
    // Arrange - 同じ作品として推定されるが、実際は別作品
    const paths = [
      writeArchive(sidecar.workDir, "混在 第01巻.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
      writeArchive(sidecar.workDir, "混在 第02巻.zip", [
        { name: "001.jpg", color: "#00ff00" },
      ]),
      writeArchive(sidecar.workDir, "別作品 第01巻.zip", [
        { name: "001.jpg", color: "#0000ff" },
      ]),
    ];
    await openOrganize(page, join(sidecar.workDir, "out2"));
    await selectArchives(page, paths);
    await page.getByTestId("estimate").click();

    const groups = page.getByTestId("series-group");
    await expect(groups).toHaveCount(2);

    // 並び順は題名順なので、位置ではなく題名で指す
    const mixed = page.locator('[data-testid="series-group"][data-title="混在"]');
    const other = page.locator('[data-testid="series-group"][data-title="別作品"]');
    await expect(mixed.getByTestId("volume")).toHaveCount(2);
    await expect(other.getByTestId("volume")).toHaveCount(1);

    // Act - 「混在」の 2 巻目を「別作品」へ移す
    // Radix の Select は listbox を開いてから選ぶ
    await mixed.getByTestId("volume").nth(1).getByTestId("move-to").click();
    await page.getByRole("option", { name: "別作品" }).click();

    // Assert
    await expect(mixed.getByTestId("volume")).toHaveCount(1);
    await expect(other.getByTestId("volume")).toHaveCount(2);
  });

  test("巻の重複を警告する", async ({ page }) => {
    // Arrange
    const paths = [
      writeArchive(sidecar.workDir, "重複 第01巻.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
      writeArchive(sidecar.workDir, "重複 第01巻 (2).zip", [
        { name: "001.jpg", color: "#00ff00" },
      ]),
    ];
    await openOrganize(page, join(sidecar.workDir, "out3"));
    await selectArchives(page, paths);
    await page.getByTestId("estimate").click();

    // Assert
    await expect(page.getByTestId("duplicate-warning")).toBeVisible();
  });

  test("整理とページ修正を切り替えられる", async ({ page }) => {
    await openOrganize(page, join(sidecar.workDir, "out4"));
    await page.getByTestId("mode-pages").click();
    await expect(page.getByTestId("mode-pages")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("sources")).toBeHidden();
  });
});
