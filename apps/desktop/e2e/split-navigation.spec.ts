import { expect, test, type Page } from "@playwright/test";
import { runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * ページ分割で候補へ送る・割ったことが見える・左から右の並びで出る（#131 #132 #137）。
 *
 * - 数百ページの本でも、①の対象へスクロールせずに移れる（#131 #153）
 * - 割った対は割る前の見開きの絵で出るので、割れていることを印で示す（#132）
 * - 格子は 2 画面とも左から右へ並ぶ。右綴じに合わせて右から左にしたところ、
 *   実機で違和感が強かった（#137）
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 2 枚目と 5 枚目が見開きの、7 ページの本 */
function writeTwoSpreads(name: string): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `
import io, sys, zipfile
from PIL import Image

def png(width, colour):
    buffer = io.BytesIO()
    Image.new("RGB", (width, 900), colour).save(buffer, "PNG")
    return buffer.getvalue()

with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    for index in range(1, 8):
        wide = index in (2, 5)
        archive.writestr(f"{index:03d}.png", png(1200 if wide else 600, "#%02x8080" % (index * 30)))
`,
    target,
  );
  return target;
}

async function open(page: Page, archive: string, mode: "split" | "reorder") {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=${mode}&archive=${encodeURIComponent(archive)}`,
  );
}

const card = (page: Page, index: number) =>
  page.locator(`[data-testid="split-card"][data-index="${index}"]`);

test.describe("ページ分割: 候補へ送る・割った印・左から右の並び", () => {
  test("前後のボタンで分割候補だけを指し、端から反対の端へ循環する", async ({
    page,
  }) => {
    // Arrange
    await open(page, writeTwoSpreads("送る.zip"), "split");
    await expect(page.locator('[data-testid="split-card"]')).toHaveCount(7);
    const position = page.getByTestId("split-focus-position");

    // Assert - まだ何も指していない
    await expect(position).toHaveText("– / 2");

    // Act / Assert - 最初の候補から前へ送ると最後の候補へ循環する
    await page.getByTestId("split-next").click();
    await expect(card(page, 1)).toHaveAttribute("data-focused", "true");
    await expect(position).toHaveText("1 / 2");
    await expect(page.getByTestId("split-previous")).toBeEnabled();
    await page.getByTestId("split-previous").click();
    await expect(position).toHaveText("2 / 2");
    await page.getByTestId("split-next").click();
    await expect(position).toHaveText("1 / 2");

    // Act / Assert - 対象でないページは飛ばして、5 枚目の見開きへ
    await page.getByTestId("split-next").click();
    await expect(card(page, 4)).toHaveAttribute("data-focused", "true");
    await expect(card(page, 1)).toHaveAttribute("data-focused", "false");
    await expect(position).toHaveText("2 / 2");
    await expect(page.getByTestId("split-next")).toBeEnabled();
    await page.getByTestId("split-next").click();
    await expect(position).toHaveText("1 / 2");
    await expect(card(page, 1)).toHaveAttribute("data-focused", "true");
    await page.getByTestId("split-previous").click();
    await expect(position).toHaveText("2 / 2");

    // Act / Assert - 戻る
    await page.getByTestId("split-previous").click();
    await expect(card(page, 1)).toHaveAttribute("data-focused", "true");
  });

  test("割った行に「分割済み」が出て、格子は左から右へ並ぶ", async ({
    page,
  }) => {
    // Arrange
    await open(page, writeTwoSpreads("印.zip"), "split");
    await expect(page.locator('[data-testid="split-card"]')).toHaveCount(7);

    // Assert - 割る前は印が無い
    await expect(page.getByTestId("split-applied")).toHaveCount(0);

    // Assert - 1 枚目は 2 枚目より左にある
    const first = await card(page, 0).boundingBox();
    const second = await card(page, 1).boundingBox();
    expect(first!.x, "1 枚目が 2 枚目より左に無い").toBeLessThan(second!.x);

    // Act - すべて分割して保存する。保存すると②へ進むので、①へ戻る（#153）
    await page.getByTestId("split-all").click();
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toContainText(
      "2 枚を分割しました",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("split-step-merge")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("split-page-count")).toHaveText("9 ページ");
    await page.getByTestId("split-step-split").click();

    // Assert - 割った 2 行に印が出る。絵は割る前の見開きのままなので、
    // 印が無いと割れたかどうかが分からない
    await expect(card(page, 1).getByTestId("split-applied")).toHaveText(
      "分割済み",
    );
    await expect(card(page, 4).getByTestId("split-applied")).toHaveCount(1);
    await expect(page.getByTestId("split-applied")).toHaveCount(2);
  });

  test("ページ並べ替えも左から右へ並ぶ", async ({ page }) => {
    // Arrange
    await open(page, writeTwoSpreads("並べ替え.zip"), "reorder");
    const cards = page.getByTestId("editable-page");
    await expect(cards).toHaveCount(7);

    // Assert - 1 ページ目が左端
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(first!.x, "1 ページ目が 2 ページ目より左に無い").toBeLessThan(
      second!.x,
    );
  });
});
