import { expect, test, type Page } from "@playwright/test";
import { coloursOf, pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * サムネイル作成で、切り取った範囲に余白を足して 2:3 にする（#146）。
 *
 * 切り取る範囲の縦横比は自由。仕上がりの 2:3 はサイドカーが揃え、足りない側は
 * 切り取った画像のその辺の縁の色で塗る。右の見本も同じ結果を描く。
 * 開いたときの枠は画像の全体で、見開きだけは中央の 2:3 から始める。
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

/** 指定した点から掴んで、そのぶんだけ運ぶ */
async function dragFrom(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

async function confirm(page: Page) {
  await page.getByTestId("apply-thumbnail").click();
  await expect(page.getByTestId("cover-status")).toContainText("加工しました", {
    timeout: 30_000,
  });
}

/** 見本（canvas）の 1 点の色。縦横は見本の大きさに対する割合で指す */
async function previewColourAt(page: Page, x: number, y: number) {
  return page.getByRole("img", { name: "viewer での見え方" }).evaluate(
    (canvas: HTMLCanvasElement, [fx, fy]) => {
      const context = canvas.getContext("2d")!;
      const [red, green, blue] = context.getImageData(
        Math.floor(canvas.width * fx),
        Math.floor(canvas.height * fy),
        1,
        1,
      ).data;
      return [red, green, blue];
    },
    [x, y],
  );
}

test.describe("サムネイル作成: 切り取った範囲を 2:3 にする", () => {
  test("開いたときの枠は画像の全体で、確定すると縁の色の余白を足した 2:3 になる", async ({
    page,
  }) => {
    // Arrange - 750×1000 は 2:3 より横に広い。全体を収める 2:3 は 750×1125
    const archive = writeBandedCover("全体.zip", 750, 1000);
    await openCover(page, archive);

    // Assert - 枠は絵の全体を囲む
    const stage = (await page.getByTestId("cover-canvas").boundingBox())!;
    const frame = (await page.getByTestId("crop-frame").boundingBox())!;
    expect(Math.abs(frame.width - stage.width)).toBeLessThan(4);
    expect(Math.abs(frame.height - stage.height)).toBeLessThan(4);

    // Assert - 見本は上下に余白を足した姿。上の余白は上の縁の青に近い色
    await expect
      .poll(async () => (await previewColourAt(page, 0.5, 0.01))[2])
      .toBeGreaterThan(200);

    // Act
    await confirm(page);

    // Assert - 画像は 1 画素も切られず、上下に余白が足された
    const sizes = pageSizesOf(archive);
    const cover = Object.keys(sizes).sort()[0];
    expect(sizes[cover]).toEqual([750, 1125]);

    // Assert - 余白は白でも黒でもなく、上の辺の縁の色（左上の画素は上の余白の中）
    expect(coloursOf(archive)[cover]).toBe("#2020ff");
  });

  test("横長に切り取ると、切り取った絵の縁の色で上下を塗って 2:3 になる", async ({
    page,
  }) => {
    // Arrange - 上と下の帯を外し、灰色の所だけを横長に切り取る
    const archive = writeBandedCover("横長.zip", 750, 1000);
    await openCover(page, archive);
    const stage = (await page.getByTestId("cover-canvas").boundingBox())!;
    const frame = (await page.getByTestId("crop-frame").boundingBox())!;
    await dragFrom(
      page,
      { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
      { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
    );
    const grip = (await page.getByTestId("crop-handle").boundingBox())!;
    // 右下の角を、縦の 4 割の所まで上げる（幅はそのまま）
    await dragFrom(
      page,
      { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
      { x: grip.x + grip.width / 2, y: stage.y + stage.height * 0.4 },
    );
    const shrunk = (await page.getByTestId("crop-frame").boundingBox())!;
    // 枠を下へ運び、上の青い帯から外す
    await dragFrom(
      page,
      { x: shrunk.x + shrunk.width / 2, y: shrunk.y + shrunk.height / 2 },
      {
        x: shrunk.x + shrunk.width / 2,
        y: shrunk.y + shrunk.height / 2 + stage.height * 0.2,
      },
    );

    // Assert - 見本の上の余白は、切り取った絵の縁（灰色）の色
    await expect
      .poll(async () => (await previewColourAt(page, 0.5, 0.01))[0])
      .toBeLessThan(160);

    // Act
    await confirm(page);

    // Assert - 横長の範囲を 2:3 にしたので、幅 750 なら高さ 1125
    const sizes = pageSizesOf(archive);
    const cover = Object.keys(sizes).sort()[0];
    expect(sizes[cover]).toEqual([750, 1125]);
    // 左上の画素は上の余白の中。元の画像の縁（青）ではなく、灰色
    expect(coloursOf(archive)[cover]).toBe("#808080");
  });

  test("見開きは中央の 2:3 から始める", async ({ page }) => {
    // Arrange - 1600×1100 は見開き。片側を選んで使う絵
    const archive = writeBandedCover("見開き.zip", 1600, 1100);
    await openCover(page, archive);

    // Act - 触らずに確定する
    await confirm(page);

    // Assert - 画像の高さいっぱいの 2:3 を切り取る。余白は要らない
    const sizes = pageSizesOf(archive);
    const cover = Object.keys(sizes).sort()[0];
    expect(sizes[cover]).toEqual([733, 1100]);
  });
});
