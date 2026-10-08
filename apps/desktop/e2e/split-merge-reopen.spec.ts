import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { coloursOf, pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.use({ deviceScaleFactor: 2 });
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

test("結合保存後も表示幅に足りるプレビューを取得し、拡大・再オープン・モード切り替えで画質を保つ", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "merge-preview.zip");
  runPython(
    `import io, sys, zipfile
from PIL import Image, ImageDraw
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 for i, colour in enumerate(('red', 'blue', 'green'), 1):
  image = Image.new('RGB', (1600, 2400), colour)
  draw = ImageDraw.Draw(image)
  for x in range(0, 1600, 12): draw.line((x, 0, x, 2400), fill='black', width=2)
  b=io.BytesIO(); image.save(b, 'PNG'); z.writestr(f'{i:03d}.png', b.getvalue())`,
    archive,
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  await page.getByTestId("split-step-merge").click();
  const cards = page.getByTestId("merge-card");
  await expect(cards).toHaveCount(3);
  await cards.first().hover();
  await cards.first().getByTestId("merge-pick").click();
  await cards.nth(1).getByTestId("merge-partner").click();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("2 ページ");
  const enoughPixels = async (testId: string) => {
    await expect
      .poll(() =>
        page
          .getByTestId(testId)
          .first()
          .evaluate(
            (img: HTMLImageElement) =>
              img.naturalWidth /
              (img.getBoundingClientRect().width * window.devicePixelRatio),
          ),
      )
      .toBeGreaterThanOrEqual(0.99);
  };
  await enoughPixels("merge-image");
  await page.getByTestId("split-card-width").fill("520");
  await enoughPixels("merge-image");
  await page.reload();
  await page.getByTestId("split-step-merge").click();
  await enoughPixels("merge-image");
  await page.getByTestId("split-step-split").click();
  await enoughPixels("split-image");
  expect(Object.values(pageSizesOf(archive))).toEqual([
    [3200, 2400],
    [1600, 2400],
  ]);
});

test("開き直した細い結合画像と元から横長の画像を、切り替えずに一括分割できる", async ({
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
  await expect(page.getByTestId("split-source")).toHaveCount(0);
  await expect(splitCards.nth(0)).toHaveAttribute("data-target", "true");
  await expect(splitCards.nth(1)).toHaveAttribute("data-target", "true");
  await page.getByTestId("split-all").click();
  await expect(splitCards.nth(0)).toHaveAttribute("data-checked", "true");
  await expect(splitCards.nth(1)).toHaveAttribute("data-checked", "true");
  await page.getByTestId("split-reset").click();
  await expect(splitCards.nth(0)).toHaveAttribute("data-target", "true");
  await expect(splitCards.nth(1)).toHaveAttribute("data-target", "true");
  await page.getByTestId("split-next").click();
  await expect(splitCards.nth(0)).toHaveAttribute("data-focused", "true");
  await page.getByTestId("split-all").click();
  await expect(splitCards.nth(0)).toHaveAttribute("data-checked", "true");
  await expect(splitCards.nth(1)).toHaveAttribute("data-checked", "true");
  await page.screenshot({ path: test.info().outputPath("split-source.png") });
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("5 ページ");
  expect(Object.values(pageSizesOf(archive))).toEqual([
    [300, 900],
    [300, 900],
    [600, 900],
    [600, 900],
    [600, 900],
  ]);
  expect(Object.values(coloursOf(archive))).toEqual([
    "#ff0000",
    "#0000ff",
    "#008000",
    "#008000",
    "#ffff00",
  ]);
});
