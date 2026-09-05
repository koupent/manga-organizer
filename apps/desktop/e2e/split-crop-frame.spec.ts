import { expect, test, type Browser, type Page } from "@playwright/test";
import { derivedRecordsOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 見開きを割った本を開き直したとき、枠が「割った位置」に出ることを確かめる（#58）。
 *
 * 割った半分をサムネイル作成で開くと、画面は同梱された割る前の画像を対象に
 * 枠を置き直す（#66）。その枠がどこに来るかは記録された割る位置で決まる。
 * 中央で割ったことにして枠を置くと、利用者は自分が選んでいない範囲を
 * 前回の範囲として見せられ、そのまま確定すれば別の場所が切り出される。
 *
 * #58 より前に書かれた本の記録には位置が無い。そちらは今までどおり
 * 中央（floor(width / 2)）に落とす。両方をこの 1 本で測る。
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 割る前の見開き。左半分を赤、右半分を青にして向きが見えるようにする */
const SPREAD_SETUP = `
import io, sys, zipfile
from pathlib import Path
from PIL import Image

target = Path(sys.argv[1])
spread = Image.new("RGB", (1200, 1800), "#ff2020")
spread.paste(Image.new("RGB", (600, 1800), "#2020ff"), (600, 0))
buffer = io.BytesIO()
spread.save(buffer, "PNG")
page = io.BytesIO()
Image.new("RGB", (600, 900), "#888888").save(page, "PNG")
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("001.png", buffer.getvalue())
    archive.writestr("002.png", page.getvalue())
`;

/**
 * Stage 1 のコアで、1200 幅の見開きを x の位置で割った本を作る。
 *
 * 600（中央）で割ると、位置を読まない実装でも同じ枠に行き着く。
 * 中央からずらした位置で割ることが、このテストが何かを確かめる条件になる。
 */
function writeSplitArchive(name: string, x: number): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `${SPREAD_SETUP}
from dataclasses import replace
from manga_core.page_splitter import SplitPosition, apply_rows, scan_rows

rows = list(scan_rows(target))
apply_rows(
    target,
    [replace(rows[0], split=SplitPosition(x=int(sys.argv[2])))] + rows[1:],
)
`,
    target,
    String(x),
  );
  return target;
}

/**
 * #58 より前の書き方で右半分にした本を作る。記録は "side" だけで位置を持たない。
 *
 * 中央に落とす既定を、値を決め打ちせず実際に測るための物差しでもある。
 */
function writeLegacySplitArchive(name: string): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `${SPREAD_SETUP}
from manga_core.cover_editor import CoverTransform, apply_to_archive

apply_to_archive(target, "001.png", CoverTransform(split="right"))
`,
    target,
  );
  return target;
}

/** サムネイル作成の画面を開く。既定で先頭ページ（割った右半分）が対象になる */
async function openCover(page: Page, archive: string) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=thumbnail&archive=${encodeURIComponent(archive)}`,
  );
  await expect(page.getByTestId("crop-frame")).toBeVisible();
}

/**
 * まっさらな窓で開き直す。
 *
 * 同じ窓だと /api/image の max-age で前に見た絵が残り、いま届いている絵と
 * 区別が付かなくなる。利用者が後日また開くときにその持ち越しは無い。
 */
async function reopen(browser: Browser, archive: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openCover(page, archive);
  return page;
}

async function boxOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} が描画されていません`);
  return box;
}

/** いま画面に届いている絵そのものの寸法。表示上の数字ではなく naturalWidth */
async function shownImageSize(page: Page): Promise<[number, number]> {
  const image = page.getByTestId("cover-image");
  await expect
    .poll(
      async () =>
        image.evaluate((node) => (node as HTMLImageElement).naturalWidth > 0),
      { timeout: 20_000, message: "表示する画像が読み込まれません" },
    )
    .toBe(true);
  return image.evaluate(
    (node) =>
      [
        (node as HTMLImageElement).naturalWidth,
        (node as HTMLImageElement).naturalHeight,
      ] as [number, number],
  );
}

/**
 * 枠を、いま表示している画像の画素座標へ直す。
 *
 * 画面上の px は窓の大きさで変わる。絵の枠との比で測れば、どんな縮尺でも
 * 「画像のどこを選んでいるか」を同じ数で比べられる。
 */
async function frameInImagePixels(page: Page, source: [number, number]) {
  const image = await boxOf(page, "cover-image");
  const frame = await boxOf(page, "crop-frame");
  const scale = source[0] / image.width;
  return {
    left: (frame.x - image.x) * scale,
    top: (frame.y - image.y) * scale,
    width: frame.width * scale,
    height: frame.height * scale,
  };
}

/** 画像の画素で測った許容差。画面上の数 px ぶんに当たる */
const FRAME_TOLERANCE = 30;

/** 割る前の画像の幅と、割った位置。中央（600）ではない所を選ぶ */
const SOURCE_WIDTH = 1200;
const SOURCE_HEIGHT = 1800;
const SPLIT_X = 800;

test.describe("見開き分割: 開き直した枠が割った位置に出る", () => {
  test("割った位置を読み、中央の既定とは違う所に枠が出る", async ({
    page,
    browser,
  }) => {
    // Arrange - 物差し。#58 より前の記録（位置を持たない）を持つ本を開き、
    // 中央に落とす既定の枠がどこに出るかを、値を決め打ちせず実際に測る
    const legacy = writeLegacySplitArchive("旧い記録の右半分.zip");
    await openCover(page, legacy);
    expect(
      await shownImageSize(page),
      "位置の記録が無い本で、割る前の画像が対象になっていません",
    ).toEqual([SOURCE_WIDTH, SOURCE_HEIGHT]);
    const fallback = await frameInImagePixels(page, [
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
    ]);
    expect(
      Math.abs(fallback.left - SOURCE_WIDTH / 2),
      "位置を持たない古い本の枠が、中央から動いています",
    ).toBeLessThan(FRAME_TOLERANCE);

    // Arrange - 800 で割る。600（中央）で割ると、位置を読まない実装でも
    // 同じ枠に行き着き、このテストは何も確かめないことになる
    const archive = writeSplitArchive("割った位置の枠.zip", SPLIT_X);

    // Arrange - コア側が位置を書けていることを先に確かめる。ここを見ないと、
    // 枠が中央に出たときに「記録が無い」のか「画面が読んでいない」のか
    // 分からず、直す場所が決まらない
    const right = Object.values(derivedRecordsOf(archive))
      .flatMap((record) => record.operations)
      .find(
        (operation) =>
          operation.kind === "split" && operation.params.side === "right",
      );
    expect(right?.params, "割った位置が記録されていません").toMatchObject({
      x: SPLIT_X,
      width: SOURCE_WIDTH,
    });

    // Act - 別の機会に開き直す
    const reopened = await reopen(browser, archive);

    // Assert - 枠は割る前の画像の上に置かれる。ここが割った後の半分だと、
    // 以降の座標の読み替えそのものが意味を持たない
    expect(await shownImageSize(reopened)).toEqual([
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
    ]);

    // Assert - 枠が、割った位置から右端までに合っている
    const restored = await frameInImagePixels(reopened, [
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
    ]);
    expect(
      Math.abs(restored.left - SPLIT_X),
      `枠の左端が ${Math.round(restored.left)}px にある（割ったのは ${SPLIT_X}px）`,
    ).toBeLessThan(FRAME_TOLERANCE);
    expect(
      Math.abs(restored.width - (SOURCE_WIDTH - SPLIT_X)),
      `枠の幅が ${Math.round(restored.width)}px（割った位置から右端までは ${
        SOURCE_WIDTH - SPLIT_X
      }px）`,
    ).toBeLessThan(FRAME_TOLERANCE);

    // Assert - 中央に落とす既定と偶然一致していない。一致していたら、
    // 記録した位置を読んだのではなく、ただ真ん中を出しているだけ
    expect(
      Math.abs(restored.left - fallback.left),
      "割った位置ではなく、中央の既定が出ています",
    ).toBeGreaterThan(150);
    await reopened.context().close();
  });
});
