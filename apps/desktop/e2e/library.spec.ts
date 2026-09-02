import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

function url(mode: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    api: sidecar.baseUrl,
    token: sidecar.token,
    mode,
    ...extra,
  });
  return `/?${params}`;
}

async function openLibrary(page: Page) {
  await page.goto(url("library"));
  await expect(page.getByTestId("mode-library")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/** 辞書に 1 件記録する */
const rememberEntry = async (page: Page, title: string, author: string) => {
  await openLibrary(page);
  await page.getByTestId("new-title").fill(title);
  await page.getByTestId("new-author").fill(author);
  await page.getByTestId("library-save").click();
  await expect(
    page.locator(`[data-testid="library-entry"][data-title="${title}"]`),
  ).toBeVisible();
};

/** 整理画面を開く */
const openOrganize = async (page: Page) => {
  await page.goto(url("organize", { output: join(sidecar.workDir, "out") }));
};

/** ファイルブラウザから 1 つ選ぶ */
const pickArchive = async (page: Page, archive: string) => {
  await page.getByTestId("open-browser").click();
  await page
    .locator(
      `[data-testid="browse-entry"][data-name="${archive.split("/").pop()}"] .browser-name`,
    )
    .click();
  await page.getByTestId("open-browser").click();
};

test.describe("辞書", () => {
  test("記録・絞り込み・削除ができる", async ({ page }) => {
    await openLibrary(page);
    await expect(page.getByTestId("entry-count")).toHaveText("0 件");

    // Act - 記録する
    await page.getByTestId("new-title").fill("ワンピース");
    await page.getByTestId("new-author").fill("尾田栄一郎");
    await page.getByTestId("library-save").click();

    // Assert
    await expect(page.getByTestId("entry-count")).toHaveText("1 件");
    await expect(page.getByTestId("library-entry")).toHaveAttribute(
      "data-title",
      "ワンピース",
    );

    // Act - もう 1 件足して絞り込む
    await page.getByTestId("new-title").fill("ナルト");
    await page.getByTestId("new-author").fill("岸本斉史");
    await page.getByTestId("library-save").click();
    await expect(page.getByTestId("entry-count")).toHaveText("2 件");

    await page.getByTestId("library-search").fill("ワン");
    await expect(page.getByTestId("library-entry")).toHaveCount(1);

    // Act - 削除する
    await page.getByTestId("library-search").fill("");
    await expect(page.getByTestId("library-entry")).toHaveCount(2);
    await page
      .locator('[data-testid="library-entry"][data-title="ナルト"]')
      .getByTestId("library-delete")
      .click();
    await expect(page.getByTestId("entry-count")).toHaveText("1 件");
  });

  test("該当が無いときは案内を出す", async ({ page }) => {
    await openLibrary(page);
    await page.getByTestId("library-search").fill("該当しない語句zzz");
    await expect(page.getByText("辞書は空です")).toBeVisible();
  });

  test("作品名が空だと記録しない", async ({ page }) => {
    await openLibrary(page);
    await page.getByTestId("library-save").click();
    await expect(page.getByTestId("library-status")).toContainText(
      "作品名を入れて",
    );
  });
});

test.describe("整理のオプション", () => {
  test("推定した作品名が辞書にあれば著者が埋まる", async ({ page }) => {
    // Arrange - 先に辞書へ記録しておく
    await rememberEntry(page, "既知の作品", "既知の著者");
    const archive = writeArchive(sidecar.workDir, "既知の作品 第01巻.zip", [
      { name: "001.jpg", color: "#ff0000" },
    ]);

    // Act
    await openOrganize(page);
    await pickArchive(page, archive);
    await expect(
      page.locator('#known-titles option[value="既知の作品"]'),
    ).toHaveCount(1);
    await page.getByTestId("estimate").click();

    // Assert - 著者が自動で入る
    await expect(
      page.getByTestId("series-group").first().getByTestId("group-author"),
    ).toHaveValue("既知の著者");
  });

  test("作品名を辞書の値に直すと著者が埋まる", async ({ page }) => {
    // Arrange - 辞書と違う名前のアーカイブを用意する
    await rememberEntry(page, "既知の作品", "既知の著者");
    const archive = writeArchive(sidecar.workDir, "別の作品 第01巻.zip", [
      { name: "001.jpg", color: "#00ff00" },
    ]);

    // Act - 推定してから作品名を辞書の値へ打ち直す
    await openOrganize(page);
    await pickArchive(page, archive);
    await expect(
      page.locator('#known-titles option[value="既知の作品"]'),
    ).toHaveCount(1);
    await page.getByTestId("estimate").click();

    const group = page.getByTestId("series-group").first();
    await expect(group.getByTestId("group-title")).toHaveValue("別の作品");
    await group.getByTestId("group-title").fill("既知の作品");

    // Assert
    await expect(group.getByTestId("group-author")).toHaveValue("既知の著者");
  });

  test("元のファイルを残すを切り替えられる", async ({ page }) => {
    await page.goto(url("organize"));
    const keep = page.getByTestId("keep-originals");
    await expect(keep).toHaveAttribute("data-state", "checked");
    await keep.click();
    await expect(keep).toHaveAttribute("data-state", "unchecked");
  });

  test("出力先を辿って選べる", async ({ page }) => {
    await page.goto(url("organize"));
    await page.getByTestId("browse-output").click();
    await expect(page.getByTestId("output-browser")).toBeVisible();
    // 読み込みが終わるまでは押せない
    await expect(page.getByTestId("use-this-directory")).toBeEnabled();
    await page.getByTestId("use-this-directory").click();
    await expect(page.getByTestId("output-directory")).toHaveValue(
      sidecar.workDir,
    );
  });
});
