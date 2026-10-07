import { expect, test, type Locator } from "@playwright/test";
import { join } from "node:path";
import { coloursOf, pageEntriesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

async function remove(card: Locator) {
  await card.getByRole("button", { name: /の操作$/ }).click();
  await card
    .getByRole("menuitem", { name: "ページを削除（復元可能）", exact: true })
    .click();
}

test("削除は保存まで保留され、非表示・表示・再オープン後の復元ができる", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "delete.zip");
  runPython(
    `import io, sys, zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 for i, colour in enumerate(['#112233', '#445566', '#778899']):
  b=io.BytesIO(); Image.new('RGB', (300, 900), colour).save(b, 'PNG'); z.writestr(f'{i+1:03d}.png', b.getvalue())`,
    archive,
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  const cards = page.getByTestId("editable-page");
  await expect(cards).toHaveCount(3);
  await remove(cards.nth(1));
  await expect(cards).toHaveCount(2);
  expect(pageEntriesOf(archive)).toHaveLength(3);
  await page.getByTestId("show-deleted-pages").check();
  await expect(cards).toHaveCount(3);
  const hidden = page.locator(
    '[data-testid="editable-page"][data-deleted="true"]',
  );
  await expect(hidden).toHaveCount(1);
  await hidden.getByRole("button", { name: /の操作$/ }).click();
  await hidden
    .getByRole("menuitem", { name: "ページを復元", exact: true })
    .click();
  await expect(page.getByTestId("split-confirm")).toHaveText("確認済みにする");
  await page.getByTestId("show-deleted-pages").uncheck();
  await page.getByTestId("split-step-split").click();
  await remove(cards.nth(1));
  await page.getByTestId("undo").click();
  await expect(cards).toHaveCount(3);
  await remove(cards.nth(1));
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("2 ページ");
  await expect(page.getByTestId("page-drag-handle").first()).toBeEnabled();
  expect(Object.values(coloursOf(archive))).toEqual(["#112233", "#778899"]);
  await page.reload();
  await expect(cards).toHaveCount(2);
  await expect(page.getByTestId("show-deleted-pages")).not.toBeChecked();
  await page.getByTestId("show-deleted-pages").check();
  await expect(hidden).toHaveCount(1);
  await expect
    .poll(() =>
      hidden
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(hidden.getByTestId("page-drag-handle")).toBeDisabled();
  await hidden.getByRole("button", { name: /の操作$/ }).click();
  await hidden
    .getByRole("menuitem", { name: "ページを復元", exact: true })
    .click();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("3 ページ");
  await expect(page.getByTestId("page-drag-handle").first()).toBeEnabled();
  expect(Object.values(coloursOf(archive))).toEqual([
    "#112233",
    "#445566",
    "#778899",
  ]);
  await page.screenshot({ path: test.info().outputPath("restored.png") });
});

test("すべて削除した本も開き直して復元できる", async ({ page }) => {
  const archive = join(sidecar.workDir, "delete-all.zip");
  runPython(
    `import io, sys, zipfile
from PIL import Image
b=io.BytesIO(); Image.new('RGB', (300, 900), '#112233').save(b, 'PNG')
with zipfile.ZipFile(sys.argv[1], 'w') as z: z.writestr('001.png', b.getvalue())`,
    archive,
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  const cards = page.getByTestId("editable-page");
  await expect(cards).toHaveCount(1);
  await remove(cards.first());
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("0 ページ");
  await page.reload();
  await expect(page.getByTestId("show-deleted-pages")).toBeVisible();
  await page.getByTestId("show-deleted-pages").check();
  await expect(cards).toHaveCount(1);
  await cards
    .first()
    .getByRole("button", { name: /の操作$/ })
    .click();
  await cards
    .first()
    .getByRole("menuitem", { name: "ページを復元", exact: true })
    .click();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("1 ページ");
  expect(pageEntriesOf(archive)).toHaveLength(1);
});

test("分割済みの片側だけを削除・復元し、削除ページを挟んだ2枚も手動結合できる", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "delete-half.zip");
  runPython(
    `import io, sys, zipfile
from PIL import Image
spread=Image.new('RGB', (1200, 900), '#ff0000'); spread.paste('#0000ff', (600, 0, 1200, 900))
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 for i, image in enumerate([spread, Image.new('RGB', (600, 900), '#808080')]):
  b=io.BytesIO(); image.save(b, 'PNG'); z.writestr(f'{i+1:03d}.png', b.getvalue())`,
    archive,
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  const cards = page.getByTestId("editable-page");
  await expect(cards).toHaveCount(2);
  await page.getByTestId("split-all").click();
  await page.getByTestId("split-confirm").click();
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId("page-drag-handle").first()).toBeEnabled();
  await remove(cards.nth(1));
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("2 ページ");
  await expect(page.getByTestId("page-drag-handle").first()).toBeEnabled();
  expect(Object.values(coloursOf(archive))).toEqual(["#0000ff", "#808080"]);
  await page.getByTestId("show-deleted-pages").check();
  const hidden = page.locator(
    '[data-testid="editable-page"][data-deleted="true"]',
  );
  await hidden.getByRole("button", { name: /の操作$/ }).click();
  await hidden
    .getByRole("menuitem", { name: "ページを復元", exact: true })
    .click();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("3 ページ");
  await expect(page.getByTestId("page-drag-handle").first()).toBeEnabled();
  expect(Object.values(coloursOf(archive))).toEqual([
    "#0000ff",
    "#ff0000",
    "#808080",
  ]);
  // 再び中間のページを削除し、残った隣接ページを結合する。
  await page.getByTestId("show-deleted-pages").uncheck();
  await remove(cards.nth(1));
  await cards.first().hover();
  await cards.first().getByTestId("merge-pick").click();
  await cards.nth(1).getByTestId("merge-partner").click();
  await expect(page.getByTestId("split-focus-position")).toHaveText("– / 1");
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("1 ページ");
  await expect(cards).toHaveCount(1);
  await page.getByTestId("show-deleted-pages").check();
  await expect(hidden).toHaveCount(1);
});
