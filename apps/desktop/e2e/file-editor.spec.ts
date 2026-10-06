import { expect, test, type Page } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { coloursOf, pageEntriesOf, pageSizesOf, runPython } from "./archive";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

async function open(page: Page, archive: string) {
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, archive, mode: "edit" })}`,
  );
  await expect(page.getByTestId("editable-page").first()).toBeVisible();
}
async function save(page: Page) {
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-status")).toHaveAttribute(
    "data-state",
    "done",
  );
  await expect(page.getByTestId("split-confirm")).toBeEnabled();
}
async function drag(page: Page, from: number, to: number) {
  const cards = page.getByTestId("editable-page");
  await cards.nth(from).getByTestId("page-drag-handle").hover();
  await page.mouse.down();
  const box = await cards.nth(to).boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await page.waitForTimeout(100);
}
function book(name: string) {
  return writeArchive(sidecar.workDir, name, [
    { name: "001.png", color: "#ff0000" },
    { name: "002.png", color: "#00ff00" },
    { name: "003.png", color: "#0000ff" },
  ]);
}
async function adjust(page: Page, index: number) {
  const card = page.getByTestId("editable-page").nth(index);
  await card.getByRole("button", { name: /の操作/ }).click();
  await card.getByRole("menuitem", { name: "サムネイルの画像調整" }).click();
  await expect(page.getByTestId("cover-canvas")).toBeVisible();
}

test("2つの入口と1つのページ一覧で、変更なしでも確認済みを保存できる", async ({
  page,
}) => {
  const archive = book("review.zip");
  const before = coloursOf(archive);
  const modified = statSync(archive).mtimeMs;
  await open(page, archive);
  await expect(page.locator('[data-testid^="mode-"]')).toHaveText([
    "ディレクトリ整理",
    "ファイル編集",
  ]);
  await expect(page.getByTestId("editable-page")).toHaveCount(3);
  await expect(page.getByTestId("split-confirm")).toHaveText("確認済みにする");
  await save(page);
  expect(coloursOf(archive)).toEqual(before);
  expect(statSync(archive).mtimeMs).toBe(modified);
  expect(
    runPython(
      "import sys; from pathlib import Path; from manga_core.original_store import recorded_edits; print(recorded_edits(Path(sys.argv[1])))",
      archive,
    ),
  ).toContain("review");
});

test("左右の表示方向を替えても保存順は変わらず、再表示しても設定が残る", async ({
  page,
}) => {
  const archive = book("direction.zip");
  await open(page, archive);
  const before = readFileSync(archive);
  await page.getByTestId("page-direction").check();
  const cards = page.getByTestId("editable-page");
  expect((await cards.nth(0).boundingBox())!.x).toBeGreaterThan(
    (await cards.nth(1).boundingBox())!.x,
  );
  await expect(page.getByTestId("split-confirm")).toHaveText("確認済みにする");
  expect(readFileSync(archive)).toEqual(before);
  await page.reload();
  await expect(page.getByTestId("page-direction")).toBeChecked();
  await save(page);
  expect(pageEntriesOf(archive)).toEqual(["001.png", "002.png", "003.png"]);
});

test("ページをドラッグして変更を反映し、別のファイルには順番を持ち越さない", async ({
  page,
}) => {
  const archive = book("drag.zip");
  const before = coloursOf(archive);
  await open(page, archive);
  await drag(page, 0, 2);
  await expect(page.getByTestId("editable-page").last()).toHaveAttribute(
    "data-name",
    "001.png",
  );
  await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");
  await save(page);
  expect(coloursOf(archive)["001.png"]).toEqual(before["002.png"]);
  expect(coloursOf(archive)["003.png"]).toEqual(before["001.png"]);
  const next = book("next.zip");
  await open(page, next);
  await expect(page.getByTestId("editable-page").first()).toHaveAttribute(
    "data-name",
    "001.png",
  );
  await expect(page.getByTestId("split-confirm")).toHaveText("確認済みにする");
});

test("右クリックでサムネイルを選び、画像の中身を変えず先頭に保存する", async ({
  page,
}) => {
  const archive = book("cover-choice.zip");
  const before = coloursOf(archive);
  await open(page, archive);
  const card = page.getByTestId("editable-page").nth(2);
  await card.getByRole("group").click({ button: "right" });
  await card
    .getByRole("menuitem", { name: "サムネイルにする", exact: true })
    .click();
  await expect(page.getByTestId("editable-page").first()).toHaveAttribute(
    "data-name",
    "003.png",
  );
  await expect(page.getByTestId("editable-page").first()).toHaveAttribute(
    "data-cover",
    "true",
  );
  await save(page);
  expect(coloursOf(archive)["001.png"]).toEqual(before["003.png"]);
});

test("途中のページの画像調整は保留され、上の保存ボタンで表紙と順番をまとめて反映する", async ({
  page,
}) => {
  const archive = book("cover-adjust.zip");
  const before = readFileSync(archive);
  await open(page, archive);
  await adjust(page, 2);
  await expect(page.getByTestId("cover-image")).toHaveAttribute(
    "alt",
    "003.png",
  );
  await page.getByTestId("rotate").click();
  await page.getByTestId("apply-thumbnail").click();
  await expect(page.getByTestId("cover-canvas")).toHaveCount(0);
  expect(readFileSync(archive)).toEqual(before);
  await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");
  await save(page);
  expect(pageSizesOf(archive)["001.png"]).toEqual([400, 600]);
  await expect(page.getByTestId("editable-page")).toHaveCount(3);
});

test("分割の保留を消さず結合モードへ移り、保存後の半ページを個別に並べ替えられる", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "split-and-reorder.zip");
  runPython(
    `import io, sys, zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 for i, size in enumerate([(600,900),(1200,900),(600,900)], 1):
  im=Image.new('RGB',size, ['red','blue','green'][i-1]); b=io.BytesIO(); im.save(b,'PNG'); z.writestr(f'{i:03d}.png',b.getvalue())`,
    archive,
  );
  await open(page, archive);
  await page.getByTestId("split-step-split").click();
  await page.getByTestId("split-all").click();
  await page.getByTestId("split-step-merge").click();
  await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");
  await save(page);
  expect(pageEntriesOf(archive)).toHaveLength(4);
  await page.getByTestId("editor-pages").click();
  await expect(page.getByTestId("editable-page")).toHaveCount(4);
  await drag(page, 1, 3);
  await save(page);
  expect(pageEntriesOf(archive)).toHaveLength(4);
});

test("変換後の名前全体を変更でき、プレビューの名前でZIPが出来上がる", async ({
  page,
}) => {
  const archive = book("special-vol01.zip");
  const output = join(sidecar.workDir, "output");
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({ json: { author: null, candidates: [] } }),
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "organize", output })}`,
  );
  await page.getByTestId("open-browser").click();
  await page
    .locator(
      `[data-testid="browse-entry"][data-name="${basename(archive)}"] .browser-name`,
    )
    .click();
  await page.getByTestId("browse-close").click();
  await page.getByTestId("organize-title").fill("作品");
  await page.getByTestId("organize-author").fill("著者");
  await page.getByTestId("edit-filename").click();
  await page.getByTestId("filename-input").fill("[著者] 作品 特典");
  await page.getByTestId("filename-confirm").click();
  await expect(page.getByTestId("plan-row-name")).toHaveText(
    "[著者] 作品 特典.zip",
  );
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("organize-status")).toContainText(
    "整理しました",
  );
  await expect(page.getByTestId("plan-to-edit")).toHaveCount(1);
  await page.getByTestId("plan-to-edit").click();
  await expect(page.getByTestId("archive-name")).toHaveText(
    "[著者] 作品 特典.zip",
  );
});

test("大きな窓でも小さな窓でも、全モードの操作と画像調整が画面内に収まる", async ({
  page,
}, testInfo) => {
  const archive = writeArchive(
    sidecar.workDir,
    "layout.zip",
    Array.from({ length: 24 }, (_, index) => ({
      name: `${String(index + 1).padStart(3, "0")}.png`,
      color: index % 2 ? "#123456" : "#56789a",
    })),
  );
  await open(page, archive);
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 860 },
    { width: 1000, height: 560 },
  ]) {
    await page.setViewportSize(viewport);
    for (const mode of [
      "editor-pages",
      "split-step-split",
      "split-step-merge",
    ]) {
      await page.getByTestId(mode).click();
      await expect(page.getByTestId("split-confirm")).toBeInViewport();
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= innerHeight,
        ),
      ).toBe(true);
    }
    await page.getByTestId("editor-pages").click();
    if (viewport.width === 1920)
      await page.screenshot({ path: testInfo.outputPath("editor-wide.png") });
  }
  await page.screenshot({ path: testInfo.outputPath("editor-small.png") });
  await adjust(page, 0);
  await expect(page.getByTestId("apply-thumbnail")).toBeInViewport();
  await expect(page.getByTestId("cover-image")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("cover-small.png") });
});
