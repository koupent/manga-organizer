import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageEntriesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

async function layout(page: Page) {
  return page.getByTestId("editable-page").evaluateAll((cards) =>
    cards.map((card) => {
      const box = card.getBoundingClientRect();
      return {
        name: card.getAttribute("data-name"),
        x: Math.round(box.x),
        y: Math.round(
          box.y + (card.closest('[data-testid="split-grid"]')?.scrollTop ?? 0),
        ),
        width: Math.round(box.width),
        height: Math.round(box.height),
        images: Array.from(card.querySelectorAll("img")).map((img) => img.src),
      };
    }),
  );
}

test("行末の結合も両モードで同じ姿・位置になり、保存前後とも分割できる", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "row-boundary.zip");
  runPython(
    `import io, sys, zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 for i in range(16):
  b=io.BytesIO(); Image.new('RGB', (300, 900), (i*13, 255-i*11, i*7)).save(b, 'PNG'); z.writestr(f'{i+1:03d}.png', b.getvalue())`,
    archive,
  );
  const original = readFileSync(archive);
  await page.setViewportSize({ width: 1318, height: 890 });
  const url = `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`;
  await page.goto(url);
  const cards = page.getByTestId("merge-card");
  await expect(cards).toHaveCount(16);
  const before = await layout(page);
  const columns = before.findIndex((item) => item.y !== before[0].y);
  expect(columns).toBeGreaterThan(2);
  const index = columns - 1;
  const merge = async () => {
    await cards.nth(index).hover();
    await cards.nth(index).getByTestId("merge-pick").click();
    await cards
      .nth(index + 1)
      .getByTestId("merge-partner")
      .click();
  };
  await merge();
  await expect(cards).toHaveCount(15);
  await expect(page.getByTestId("split-focus-position")).toHaveText("– / 1");
  await page.getByTestId("split-next").click();
  await expect(cards.nth(index)).toHaveAttribute("data-focused", "true");
  await page.getByTestId("split-next").click();
  await expect(cards.nth(index)).toHaveAttribute("data-focused", "true");
  const merged = await layout(page);
  expect(merged[index].x).toBe(merged[0].x);
  expect(merged[index].y).toBeGreaterThan(merged[0].y);
  expect(merged[index].images).toHaveLength(2);
  await page.screenshot({ path: test.info().outputPath("merge.png") });
  await page.getByTestId("split-step-split").click();
  expect(await layout(page)).toEqual(merged);
  await page.getByTestId("split-source").click();
  await page
    .getByRole("option", { name: "結合・復元した画像", exact: true })
    .click();
  await expect(page.getByTestId("split-focus-position")).toHaveText("– / 1");
  await page.getByTestId("split-next").click();
  await expect(
    page.locator(`[data-testid="split-card"][data-index="${index}"]`),
  ).toHaveAttribute("data-focused", "true");
  await page.screenshot({ path: test.info().outputPath("split.png") });
  await page.getByTestId("split-all").click();
  await expect(page.getByTestId("split-status")).toHaveText("変更はありません");
  await expect(page.getByTestId("editable-page")).toHaveCount(16);
  expect(readFileSync(archive)).toEqual(original);

  await page.getByTestId("split-step-merge").click();
  await merge();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("15 ページ");
  await expect(page.getByTestId("page-drag-handle").first()).toBeEnabled();
  await page.reload();
  await page.getByTestId("split-step-merge").click();
  await expect(cards).toHaveCount(15);
  const saved = await layout(page);
  await expect(page.getByTestId("split-focus-position")).toHaveText("– / 1");
  await page.getByTestId("split-next").click();
  await expect(cards.nth(index)).toHaveAttribute("data-focused", "true");
  await cards.nth(index).press("Enter");
  await expect(page.getByTestId("split-confirm")).toHaveText("確認済みにする");
  await page.getByTestId("split-step-split").click();
  expect(await layout(page)).toEqual(saved);
  await page.getByTestId("split-source").click();
  await page
    .getByRole("option", { name: "結合・復元した画像", exact: true })
    .click();
  await expect(page.getByTestId("split-focus-position")).toHaveText("– / 1");
  await page.getByTestId("split-all").click();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("16 ページ");
  expect(pageEntriesOf(archive)).toHaveLength(16);
});
