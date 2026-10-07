import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { coloursOf, pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

test("開き直した細い結合画像も、元から横長の画像と分けて一括分割できる", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "narrow-merge.zip");
  runPython(
    `import io, sys, zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 for i, (width, colour) in enumerate(((300,'red'), (300,'blue'), (1200,'green'), (600,'yellow')), 1):
  b=io.BytesIO(); Image.new('RGB', (width, 900), colour).save(b, 'PNG'); z.writestr(f'{i:03d}.png', b.getvalue())`,
    archive,
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  await page.getByTestId("split-step-merge").click();
  const cards = page.getByTestId("merge-card");
  await expect(cards).toHaveCount(4);
  await cards.first().hover();
  await cards.first().getByTestId("merge-pick").click();
  await cards.nth(1).getByTestId("merge-partner").click();
  await expect(page.getByTestId("unmerge-all")).toHaveCount(0);
  await expect(cards.first().getByTestId("merge-undo")).toHaveText(
    "結合を取り消す",
  );
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("3 ページ");
  await page.reload();
  await page.getByTestId("split-step-merge").click();
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId("unmerge-all")).toHaveCount(0);
  await expect(page.getByTestId("merge-undo")).toHaveCount(0);
  await page.getByTestId("split-step-split").click();
  const splitCards = page.getByTestId("split-card");
  await expect(splitCards.nth(0)).toHaveAttribute("data-target", "false");
  await expect(splitCards.nth(1)).toHaveAttribute("data-target", "true");
  await page.getByTestId("split-all").click();
  await expect(splitCards.nth(0)).toHaveAttribute("data-checked", "false");
  await expect(splitCards.nth(1)).toHaveAttribute("data-checked", "true");
  await page.getByTestId("split-reset").click();
  await page.getByTestId("split-source").click();
  await page.getByRole("option", { name: "両方", exact: true }).click();
  await expect(splitCards.nth(0)).toHaveAttribute("data-target", "true");
  await expect(splitCards.nth(1)).toHaveAttribute("data-target", "true");
  await page.getByTestId("split-source").click();
  await page
    .getByRole("option", { name: "結合・復元した画像", exact: true })
    .click();
  await expect(splitCards.nth(0)).toHaveAttribute("data-target", "true");
  await expect(splitCards.nth(1)).toHaveAttribute("data-target", "false");
  await page.getByTestId("split-next").click();
  await expect(splitCards.nth(0)).toHaveAttribute("data-focused", "true");
  await page.getByTestId("split-all").click();
  await expect(splitCards.nth(0)).toHaveAttribute("data-checked", "true");
  await expect(splitCards.nth(1)).toHaveAttribute("data-checked", "false");
  await page.screenshot({ path: test.info().outputPath("split-source.png") });
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("4 ページ");
  expect(Object.values(pageSizesOf(archive))).toEqual([
    [300, 900],
    [300, 900],
    [1200, 900],
    [600, 900],
  ]);
  expect(Object.values(coloursOf(archive))).toEqual([
    "#ff0000",
    "#0000ff",
    "#008000",
    "#ffff00",
  ]);
});
