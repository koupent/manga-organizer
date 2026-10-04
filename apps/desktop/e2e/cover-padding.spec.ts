import { expect, test, type Page } from "@playwright/test";
import { coloursOf, pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * サムネイル作成の枠を画像の外まで広げ、はみ出した所を縁の色で塗る（#130）。
 *
 * 2:3 に収まらない表紙を切らずに使うため。上限は「画像の全体がちょうど収まる
 * 2:3」で、それより先は余白が増えるだけなので広げられない。見開きは片側を
 * 選んで使う絵なので、今までどおり画像の内側に限る。
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 上の縁が青、下の縁が赤、真ん中が灰色の表紙（width × height）を先頭に持つ本 */
function writeBandedCover(name: string, width: number, height: number) {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `
import io, sys, zipfile
from PIL import Image
width, height = int(sys.argv[2]), int(sys.argv[3])
cover = Image.new("RGB", (width, height), "#808080")
cover.paste((32, 32, 255), (0, 0, width, height // 10))
cover.paste((255, 32, 32), (0, height - height // 10, width, height))
buffer = io.BytesIO()
cover.save(buffer, "PNG")
page = io.BytesIO()
Image.new("RGB", (600, 900), "#888888").save(page, "PNG")
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("001.png", buffer.getvalue())
    archive.writestr("002.png", page.getvalue())
`,
    target,
    String(width),
    String(height),
  );
  return target;
}

async function openCover(page: Page, archive: string) {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=thumbnail&archive=${encodeURIComponent(archive)}`,
  );
  await expect(page.getByTestId("crop-frame")).toBeVisible();
}

/** 角を掴んで、窓の右下いっぱいまで運ぶ */
async function growAsFarAsPossible(page: Page) {
  const grip = (await page.getByTestId("crop-handle").boundingBox())!;
  const viewport = page.viewportSize()!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewport.width - 1, viewport.height - 1, {
    steps: 12,
  });
  await page.mouse.up();
}

test.describe("サムネイル作成: 枠を画像の外まで広げる", () => {
  test("広げて確定すると、画像の全体が 2:3 に収まり、余白は縁の色になる", async ({
    page,
  }) => {
    // Arrange - 750×1000 は 2:3 より横に広い。全体を収める 2:3 は 750×1125
    const archive = writeBandedCover("広げる.zip", 750, 1000);
    await openCover(page, archive);

    // Assert - 余白の場所が縁の色で用意されている
    await expect(page.getByTestId("cover-pad")).toHaveCount(2);

    // Act
    await growAsFarAsPossible(page);
    await page.getByTestId("apply-thumbnail").click();
    await expect(page.getByTestId("cover-status")).toContainText(
      "加工しました",
      { timeout: 30_000 },
    );

    // Assert - 画像は 1 画素も切られず、上下に余白が足された
    const sizes = pageSizesOf(archive);
    const cover = Object.keys(sizes).sort()[0];
    expect(sizes[cover]).toEqual([750, 1125]);

    // Assert - 余白は白でも黒でもなく、上の辺の縁の色（左上の画素は上の余白の中）
    expect(coloursOf(archive)[cover]).toBe("#2020ff");
  });

  test("見開きは今までどおり画像の内側に限る", async ({ page }) => {
    // Arrange - 1600×1100 は見開き。片側を選んで使う絵
    const archive = writeBandedCover("見開き.zip", 1600, 1100);
    await openCover(page, archive);

    // Assert - 余白の場所は無い
    await expect(page.getByTestId("cover-pad")).toHaveCount(0);

    // Act
    await growAsFarAsPossible(page);
    await page.getByTestId("apply-thumbnail").click();
    await expect(page.getByTestId("cover-status")).toContainText(
      "加工しました",
      { timeout: 30_000 },
    );

    // Assert - 画像の高さいっぱいの 2:3 までしか広がらない
    const sizes = pageSizesOf(archive);
    const cover = Object.keys(sizes).sort()[0];
    expect(sizes[cover][1]).toBeLessThanOrEqual(1100);
  });
});
