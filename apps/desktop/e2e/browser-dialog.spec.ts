import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * ファイルブラウザを別窓（Dialog）へ移す（段階 1）。
 *
 * 利用者の困りごとは
 *
 *   「解析対象のフォルダを追加しているところと、解析対象の結果が
 *     結構混ざったような表示になる」
 *   「同じ右側のリストのところで表現しているのがあまり良くない」
 *
 * 元凶は `FilePicker.tsx` の `{browsing ? browser : dropzone}` で、右側の
 * 1 枚の面を「投入」「ファイルブラウザ」「解析結果」の 3 者が奪い合っている。
 * ファイルを選んでいる間、投入した一覧が画面から消えるので、何階層も辿って
 * 何件も入れる作業を、入れた一覧を見ないまま進めることになる。
 *
 * この段階では中身（`file-browser` の見た目・文言・操作）は変えず、置き場所
 * だけを別窓へ移す。据え置く契約は次のとおり。
 *
 * - `open-browser`  … 開閉のボタン。**トグルのまま**（既存の 12 本が前提にする）
 * - `file-browser`  … 辿る一覧そのもの
 * - `browse-entry` / `.browser-name` / `browse-up` / `add-all-here`
 * - 行ごとの「フォルダごと追加」
 *
 * 別窓は `apps/desktop/src/components/ui/dialog.tsx` の `DialogContent` を
 * そのまま使う（`DirectoryPicker.tsx` の出力先ブラウザが手本）。Dialog 自体は
 * 触らない。1 冊だけ選ぶ画面（single）も同じ窓を使い、これで
 * `{browsing ? browser : dropzone}` の入れ替わりを消す。
 */

/** 実際に使う窓の大きさ。既存のレイアウト検証と揃える */
const VIEWPORT = { width: 1280, height: 860 };

/** 投入する件数。1 件だと「たまたま残っていた」と区別できない */
const DROPPED = 3;

/** 投入する素材を置く場所。ここまで辿ってから選ぶ */
const ARCHIVE_DIR = "窓の素材";

/** アーカイブもフォルダも無い場所（段階 4） */
const EMPTY_DIR = "何も無い場所";

/** 3 段の入れ子。パンくずで飛べることを見る */
const NESTED = ["一段目", "二段目", "三段目"];

/** 1 冊だけ選ぶ画面で使うアーカイブのページ数 */
const REORDER_PAGES = 2;

let sidecar: Sidecar;
let archiveNames: string[];

test.beforeAll(async () => {
  sidecar = await startSidecar();
  mkdirSync(join(sidecar.workDir, ARCHIVE_DIR), { recursive: true });
  archiveNames = Array.from(
    { length: DROPPED },
    (_, index) => `窓の作品 第${String(index + 1).padStart(2, "0")}巻.zip`,
  );
  for (const name of archiveNames) {
    writeArchive(sidecar.workDir, `${ARCHIVE_DIR}/${name}`, [
      { name: "001.jpg", color: "#ff0000" },
    ]);
  }
  mkdirSync(join(sidecar.workDir, EMPTY_DIR), { recursive: true });
  mkdirSync(join(sidecar.workDir, ...NESTED), { recursive: true });
});

test.afterAll(() => sidecar?.stop());

/** 投入したものが並ぶ、一番外側の行。解析で生える本の行と混ざらないよう深さで絞る */
function droppedRows(page: Page) {
  return page.locator('[data-testid="source-row"]');
}

/** 名指しの 1 行。件数は同一性の代わりにならないので、パスで指す */
function droppedRow(page: Page, path: string) {
  return page.locator(`[data-testid="source-row"][data-path="${path}"]`);
}

/** ファイル整理を開く。出力先は先に決めておき、未入力の警告を出さない */
async function openOrganize(page: Page, outputName: string) {
  const output = join(sidecar.workDir, outputName);
  mkdirSync(output, { recursive: true });
  await page.setViewportSize(VIEWPORT);
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("confirm")).toBeVisible();
}

/** 対象を選ばずにページ並べ替えを開く */
async function openReorder(page: Page) {
  await page.setViewportSize(VIEWPORT);
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=reorder`,
  );
  await expect(page.getByTestId("mode-edit")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/** 外部検索を「候補なし」に固定する。著者の補完はここでは見ない */
async function stubNoSuggestions(page: Page) {
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ author: null, candidates: [] }),
    }),
  );
}

/** ファイルブラウザを開き、素材の置き場所まで辿る */
async function enterArchiveDirectory(page: Page) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  await page
    .locator(
      `[data-testid="browse-entry"][data-name="${ARCHIVE_DIR}"] .browser-name`,
    )
    .click();
  // 一覧が出揃うまで待つ。届いていない行は押せない
  await expect(
    page.locator('[data-testid="browse-entry"][data-name$=".zip"]'),
  ).toHaveCount(DROPPED);
}

/**
 * DROPPED 件を投入し、ファイルブラウザを閉じた状態にする。
 *
 * 閉じるところまでを準備に含めるのは、「開いている間も一覧が見える」ことを
 * 開き直して確かめたいため。開きっぱなしのまま投入して見ると、閉じてから
 * 開く経路（利用者が実際にする操作）を通らない。
 */
async function fillSelection(page: Page) {
  await enterArchiveDirectory(page);
  for (const name of archiveNames) {
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${name}"] .browser-name`,
      )
      .click();
  }
  await expect(page.getByTestId("selected-count")).toHaveText(`${DROPPED} 件`);
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeHidden();
  await expect(droppedRows(page)).toHaveCount(DROPPED);
}

test.describe("ファイルブラウザを別窓で出す", () => {
  test("ファイルを選ぶ間も、投入した一覧が見えている", async ({ page }) => {
    // Arrange - 一覧に中身がある状態から始める。空の一覧では
    // 「消えていない」ことを確かめようがない
    await openOrganize(page, "out-dialog-keeps-list");
    await stubNoSuggestions(page);
    await fillSelection(page);
    const first = join(sidecar.workDir, ARCHIVE_DIR, archiveNames[0]);
    await expect(droppedRow(page, first)).toBeVisible();

    // Act - ファイルを選ぶ
    await page.getByTestId("open-browser").click();

    // Assert - 別窓が開いている。行だけを見ると、ボタンが壊れて何も開かない
    // 実装でも通ってしまう。窓が開いていることと一覧が見えていることの
    // 両方を、同じテストの中で見る
    await expect(
      page.getByRole("dialog"),
      "ファイルブラウザが別窓になっていない",
    ).toBeVisible();
    await expect(page.getByTestId("file-browser")).toBeVisible();

    // Assert - 投入した一覧はそのまま見えている。件数ではなくパスで名指しした
    // 1 行の可視性を見る。件数は同一性の代わりにならない
    await expect(
      droppedRow(page, first).first(),
      "ファイルを選ぶ間に、投入した一覧が画面から消えている",
    ).toBeVisible();

    // Assert - 中身は今のまま。窓へ移すついでに操作を落とさない
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("browse-up")).toBeVisible();
    await expect(dialog.getByTestId("add-here")).toHaveText(
      "ここをフォルダごと追加",
    );
  });

  test("Esc で閉じても、投入した一覧はそのまま", async ({ page }) => {
    // Arrange
    await openOrganize(page, "out-dialog-escape");
    await stubNoSuggestions(page);
    await fillSelection(page);
    await page.getByTestId("open-browser").click();
    await expect(page.getByTestId("file-browser")).toBeVisible();

    // Act - 別窓なら Esc で閉じられる。今の実装には Esc の経路が無い
    await page.keyboard.press("Escape");

    // Assert - 窓は閉じる
    await expect(
      page.getByTestId("file-browser"),
      "Esc でファイルブラウザが閉じない",
    ).toBeHidden();

    // Assert - 閉じ方が変わっても投入した内容は失われない。
    // 「全部消して閉じる」実装をここで弾く
    await expect(
      page.getByTestId("selected-count"),
      "Esc で閉じたら投入した件数が変わっている",
    ).toHaveText(`${DROPPED} 件`);
    const first = join(sidecar.workDir, ARCHIVE_DIR, archiveNames[0]);
    await expect(droppedRow(page, first)).toBeVisible();
  });

  test("1 冊だけ選ぶ画面でも同じ窓が開く", async ({ page }) => {
    // Arrange - ページ並べ替えは 1 冊しか扱えない。投入の入り口は
    // ファイル整理と同じものを使う
    const archive = writeArchive(sidecar.workDir, "窓で選ぶ.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
    ]);
    await openReorder(page);

    // Act
    await page.getByTestId("open-browser").click();

    // Assert - 同じ別窓が開く
    await expect(
      page.getByRole("dialog"),
      "1 冊だけ選ぶ画面のファイルブラウザが別窓になっていない",
    ).toBeVisible();
    await expect(page.getByTestId("file-browser")).toBeVisible();

    // Act - アーカイブを選ぶ
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="窓で選ぶ.zip"] .browser-name`,
      )
      .click();

    // Assert - 選んだら窓は用済み。開いたままページの格子を覆わない。
    // 「開く」だけを見ると、今の経路でも半分通ってしまう
    await expect(
      page.getByTestId("file-browser"),
      "1 冊選んだのに窓が開いたまま",
    ).toBeHidden();

    // Assert - 選んだ 1 冊が実際に読み込まれている
    await expect(page.getByTestId("archive-name")).toHaveText("窓で選ぶ.zip");
    await expect(page.getByTestId("editable-page")).toHaveCount(REORDER_PAGES);
    expect(archive.endsWith("窓で選ぶ.zip")).toBe(true);
  });

  test("もう一度押すと閉じる", async ({ page }) => {
    // Arrange - 既存の 12 本の spec が「もう一度押して閉じる」を前提にしている。
    // 別窓へ移してもトグルのまま据え置くことを、ここで名指しで固定する
    await openOrganize(page, "out-dialog-toggle");

    // Act - 開く
    await page.getByTestId("open-browser").click();

    // Assert
    await expect(page.getByTestId("file-browser")).toBeVisible();

    // Act - 同じボタンをもう一度押す
    await page.getByTestId("open-browser").click();

    // Assert - 閉じる。開くだけのボタンにしない
    await expect(
      page.getByTestId("file-browser"),
      "同じボタンをもう一度押しても閉じない",
    ).toBeHidden();
  });

  test("窓の見出しと底の行が見え、「閉じる」で閉じても投入はそのまま", async ({
    page,
  }) => {
    // Arrange
    await openOrganize(page, "out-dialog-frame");
    await stubNoSuggestions(page);
    await fillSelection(page);

    // Act
    await page.getByTestId("open-browser").click();

    // Assert - 何をする窓なのかを見出しで言う
    const dialog = page.getByTestId("file-browser");
    await expect(dialog.getByText("投入するものを選ぶ")).toBeVisible();
    await expect(
      dialog.getByText("フォルダは下の階層まで辿って入れます"),
    ).toBeVisible();
    await expect(dialog.getByTestId("browse-footer")).toContainText(
      `投入したもの: ${DROPPED} 件`,
    );
    await expect(dialog.getByTestId("browse-footer")).toContainText(
      "追加しても閉じません",
    );

    // Act
    await dialog.getByTestId("browse-close").click();

    // Assert
    await expect(page.getByTestId("file-browser")).toBeHidden();
    await expect(page.getByTestId("selected-count")).toHaveText(
      `${DROPPED} 件`,
    );
  });

  test("アーカイブの無い場所でも「ここをフォルダごと追加」は 0 件にならない", async ({
    page,
  }) => {
    // Arrange
    await openOrganize(page, "out-dialog-add-here");
    await page.getByTestId("open-browser").click();
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${EMPTY_DIR}"] .browser-name`,
      )
      .click();

    // Assert - 中身が無いことを黙らずに言う。「全部追加」は無い
    const dialog = page.getByTestId("file-browser");
    await expect(dialog.getByTestId("browse-empty")).toHaveText(
      "この中にフォルダもアーカイブもありません",
    );
    await expect(dialog.getByTestId("add-all-here")).toHaveCount(0);

    // Act
    await dialog.getByTestId("add-here").click();

    // Assert - この場所そのものが入る。印に替わり、もう押せない
    await expect(page.getByTestId("selected-count")).toHaveText("1 件");
    await expect(
      page.locator(
        `[data-testid="source-row"][data-path="${join(sidecar.workDir, EMPTY_DIR)}"]`,
      ),
    ).toBeVisible();
    await expect(dialog.getByTestId("add-here")).toHaveCount(0);
    await expect(dialog.getByTestId("browse-here-state")).toHaveText(
      "この場所は追加済み",
    );
  });

  test("フォルダごと入れたら、その中では追加のボタンを出さない", async ({
    page,
  }) => {
    // Arrange
    await openOrganize(page, "out-dialog-inside");
    await page.getByTestId("open-browser").click();
    const dialog = page.getByTestId("file-browser");
    const folderRow = dialog.locator(
      `[data-testid="browse-entry"][data-name="${ARCHIVE_DIR}"]`,
    );

    // Act
    await folderRow.getByRole("button", { name: "フォルダごと追加" }).click();

    // Assert - 入れたフォルダの行は印に替わる。隣のフォルダはまだ入れられる
    await expect(folderRow.getByTestId("browse-added")).toHaveText("追加済み");
    await expect(
      folderRow.getByRole("button", { name: "フォルダごと追加" }),
    ).toHaveCount(0);
    await expect(
      dialog
        .locator(`[data-testid="browse-entry"][data-name="${EMPTY_DIR}"]`)
        .getByRole("button", { name: "フォルダごと追加" }),
    ).toBeVisible();

    // Act - 入れたフォルダの中へ入る
    await folderRow.locator(".browser-name").click();

    // Assert - 中の行は「上のフォルダごと追加済み」で、ボタンも二重の追加も無い
    const inside = dialog.locator('[data-testid="browse-entry"]');
    await expect(inside).toHaveCount(DROPPED);
    // 名前そのものも押せる要素なので、追加のボタンだけを名前で数える
    await expect(inside.getByRole("button", { name: /追加/ })).toHaveCount(0);
    await expect(inside.first()).toContainText("上のフォルダごと追加済み");
    // 入れたフォルダそのものの中なので、この場所が追加済み
    await expect(dialog.getByTestId("browse-here-state")).toHaveText(
      "この場所は追加済み",
    );
    await inside.first().locator(".browser-name").click();
    await expect(page.getByTestId("selected-count")).toHaveText("1 件");
  });

  test("アーカイブの行は「追加」で入れ、追加済みの印に替わる", async ({
    page,
  }) => {
    // Arrange
    await openOrganize(page, "out-dialog-add-one");
    await enterArchiveDirectory(page);
    const row = page.locator(
      `[data-testid="browse-entry"][data-name="${archiveNames[0]}"]`,
    );

    // Act
    await row.getByRole("button", { name: "追加" }).click();

    // Assert
    await expect(page.getByTestId("selected-count")).toHaveText("1 件");
    await expect(row.getByTestId("browse-added")).toHaveText("追加済み");
    await expect(
      row.getByRole("button", { name: "追加", exact: true }),
    ).toHaveCount(0);
  });

  test("パンくずの 1 段を押すと、その階層へ飛べる", async ({ page }) => {
    // Arrange - 3 段潜る
    await openOrganize(page, "out-dialog-crumbs");
    await page.getByTestId("open-browser").click();
    const dialog = page.getByTestId("file-browser");
    for (const name of NESTED) {
      await dialog
        .locator(
          `[data-testid="browse-entry"][data-name="${name}"] .browser-name`,
        )
        .click();
      await expect(dialog.getByTestId("browse-crumb").last()).toHaveText(name);
    }

    // Act - 一番上（許された場所の根）へ飛ぶ
    await dialog.getByTestId("browse-crumb").first().click();

    // Assert - 根にしか無い名前が見える
    await expect(
      dialog.locator(
        `[data-testid="browse-entry"][data-name="${ARCHIVE_DIR}"]`,
      ),
    ).toBeVisible();
    await expect(dialog.getByTestId("browse-crumb")).toHaveCount(1);
  });

  test("1 冊だけ選ぶ画面では、アーカイブの行に「開く」があり、押すと読み込む", async ({
    page,
  }) => {
    // Arrange
    writeArchive(sidecar.workDir, "開いて選ぶ.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
    ]);
    await openReorder(page);
    await page.getByTestId("open-browser").click();
    const dialog = page.getByTestId("file-browser");

    // Assert - 底の行が振る舞いを言う。フォルダの行には追加のボタンが無い
    await expect(dialog.getByTestId("browse-footer")).toContainText(
      "選ぶとすぐに開きます",
    );
    await expect(
      dialog
        .locator(`[data-testid="browse-entry"][data-name="${ARCHIVE_DIR}"]`)
        .getByRole("button", { name: /開く|追加/ }),
    ).toHaveCount(0);

    // Act
    await dialog
      .locator('[data-testid="browse-entry"][data-name="開いて選ぶ.zip"]')
      .getByRole("button", { name: "開く" })
      .click();

    // Assert
    await expect(page.getByTestId("file-browser")).toBeHidden();
    await expect(page.getByTestId("archive-name")).toHaveText("開いて選ぶ.zip");
  });
});
