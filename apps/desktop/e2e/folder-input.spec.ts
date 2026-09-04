import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * フォルダを丸ごと投入できることを見る（#70 第 1 段階）。
 *
 * 実測で、1 階層のサブフォルダを含むフォルダから 5 件のアーカイブを集めるのに
 * 13 回のクリックが要った。いまの「中身を追加」（FilePicker.tsx）は browse を
 * 1 回呼ぶだけで、返ってきた直下のファイルしか入れない。サブフォルダの中は
 * 手で辿って 1 つずつ選ぶしかない。
 *
 * 一覧の見た目（3 階層・チェックボックス）は第 3 段階なので、ここでは
 * 「フォルダを 1 回選んだら、下のアーカイブが全部処理される」ことだけを見る。
 * 画面が実パスを展開するのか、サイドカーが再帰するのかは問わない。
 */

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => sidecar?.stop());

/** 出力先に出来たファイルの名前を列挙する */
function producedNames(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .map((entry) => entry.split("/").pop()!)
      .filter((name) => name.endsWith(".zip"))
      .sort();
  } catch {
    return [];
  }
}

async function openOrganize(page: Page, output: string) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/** 作品名と著者を入れる。外部検索は見ないので応答を固定する */
async function fillMangaInfo(page: Page, title: string, author: string) {
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ author: null, candidates: [] }),
    }),
  );
  await page.getByTestId("organize-title").fill(title);
  await page.getByTestId("organize-author").fill(author);
  await expect(page.getByTestId("organize-author")).toHaveValue(author);
}

test.describe("フォルダごとの投入", () => {
  test("フォルダを 1 回選ぶと、サブフォルダの中まで処理対象に入る", async ({
    page,
  }) => {
    // Arrange - 直下に 1 冊、サブフォルダに 1 冊、その下にもう 1 冊。
    // 直下だけを拾う実装では 1 冊しか集まらない深さにする。
    // 巻数が名前から決まるので、出来たファイル名でどれが入ったか分かる
    const folderName = "まとめて投入";
    const folder = join(sidecar.workDir, folderName);
    mkdirSync(join(folder, "サブ", "さらに深く"), { recursive: true });
    writeArchive(sidecar.workDir, join(folderName, "raw_01.zip"), [
      { name: "001.jpg", color: "#ff0000" },
    ]);
    writeArchive(sidecar.workDir, join(folderName, "サブ", "raw_02.zip"), [
      { name: "001.jpg", color: "#00ff00" },
    ]);
    writeArchive(
      sidecar.workDir,
      join(folderName, "サブ", "さらに深く", "raw_03.zip"),
      [{ name: "001.jpg", color: "#0000ff" }],
    );
    const output = join(sidecar.workDir, "out-folder-input");
    mkdirSync(output, { recursive: true });

    await openOrganize(page, output);
    await fillMangaInfo(page, "フォルダ投入", "テスト著者");

    // Act - ファイル参照を開く
    await page.getByTestId("open-browser").click();
    await expect(page.getByTestId("file-browser")).toBeVisible();

    // Assert - この画面から個別に選べるのは、そもそも直下の分だけ。
    // サブフォルダの中は行として出ていないので、1 つずつ押す道は無い
    for (const hidden of ["raw_02.zip", "raw_03.zip"]) {
      await expect(
        page.locator(`[data-testid="browse-entry"][data-name="${hidden}"]`),
        `${hidden} が直下に見えている。テストの前提（深い場所にある）が崩れている`,
      ).toHaveCount(0);
    }

    // Act - フォルダの行の操作を 1 回押すだけ。中へは辿らない
    const row = page.locator(
      `[data-testid="browse-entry"][data-name="${folderName}"]`,
    );
    const addFolder = row.locator("button:not(.browser-name)");
    await expect(
      addFolder,
      "フォルダを丸ごと入れる操作が 1 つに定まらない。1 クリックで入ると言えない",
    ).toHaveCount(1);
    await addFolder.click();

    // Assert - 押した結果、処理対象が空ではなくなる。何件の行になるかは
    // 一覧の見せ方（第 3 段階）次第なので、ここでは数を決め打ちしない
    await expect(page.getByTestId("selected-count")).not.toHaveText("0 件");

    // Act - そのまま実行する。個別のアーカイブは一度も押していない
    await page.getByTestId("open-browser").click();
    await expect(page.getByTestId("file-browser")).toBeHidden();
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 60_000 },
    );

    // Assert - 深さに関係なく 3 冊とも出来る。1 階層だけ拾う実装では
    // 第001巻 しか出ないので、そこで落ちる
    expect(producedNames(output)).toEqual([
      "[テスト著者] フォルダ投入 第001巻.zip",
      "[テスト著者] フォルダ投入 第002巻.zip",
      "[テスト著者] フォルダ投入 第003巻.zip",
    ]);
  });
});
