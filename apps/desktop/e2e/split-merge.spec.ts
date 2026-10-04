import { expect, test, type Page } from "@playwright/test";
import { coloursOf, pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * ②「見開きにする」で、隣り合う 2 ページを 1 枚の見開きへ結合する（#139 #153）。
 *
 * 分割と同じく保留にし、保存したときに 1 回だけ書き込む。結合する 2 枚は、
 * 保存する前から結合した後の見開きの姿（右に先のページ、左に次のページ）で出す。
 * 継ぎ目の色がつながる 2 枚は、結合の候補として同じ姿を点線で出す（#149）。
 *
 * サイドカー側の契約は `services/core/tests/test_page_splitter.py` の
 * `MergesTwoPagesTest`・`SuggestsMergesTest` と `test_split_api.py` の
 * `MergeTest`。
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** ページの幅（高さはどれも 900）。色でどのページか見分ける */
const WITH_SPREAD = [600, 600, 600, 1200, 600];
const SINGLES_ONLY = [600, 600, 600, 600];
const COLOURS = ["#ff0000", "#00ff00", "#0000ff", "#808080", "#ffff00"];

function writeBook(name: string, widths: number[]): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `
import io, json, sys, zipfile
from PIL import Image

def png(width, colour):
    buffer = io.BytesIO()
    Image.new("RGB", (width, 900), colour).save(buffer, "PNG")
    return buffer.getvalue()

pages = zip(json.loads(sys.argv[2]), json.loads(sys.argv[3]))
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    for index, (width, colour) in enumerate(pages, 1):
        archive.writestr(f"{index:03d}.png", png(width, colour))
`,
    target,
    JSON.stringify(widths),
    JSON.stringify(COLOURS),
  );
  return target;
}

/** 開いて②「見開きにする」へ移る。①の対象がある本は①から開くため */
async function open(page: Page, archive: string, cards: number) {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=split&archive=${encodeURIComponent(archive)}`,
  );
  await expect(page.getByTestId("split-grid")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("split-step-merge").click();
  await expect(page.locator('[data-testid="merge-card"]')).toHaveCount(cards);
}

const card = (page: Page, index: number) =>
  page.locator(`[data-testid="merge-card"][data-index="${index}"]`);

test.describe("ページ分割・結合: 2 ページを 1 枚の見開きにする", () => {
  test("結合すると見開きの姿で出て、解けば元に戻る", async ({ page }) => {
    // Arrange
    await open(page, writeBook("結合の保留.zip", WITH_SPREAD), 5);
    await expect(page.getByTestId("split-status")).toHaveText(
      "変更はありません",
    );

    // Assert - 単ページ 2 枚が続くところにだけ結合の操作が出る。見開きと、
    // 見開きの前・本の最後のページには出ない
    await expect(card(page, 0).getByTestId("split-merge")).toHaveCount(1);
    await expect(card(page, 2).getByTestId("split-merge")).toHaveCount(0);
    await expect(card(page, 3).getByTestId("split-merge")).toHaveCount(0);
    await expect(card(page, 4).getByTestId("split-merge")).toHaveCount(0);

    // Act - 2 枚目と 3 枚目を結合する
    await card(page, 1).getByTestId("split-merge").click();

    // Assert - 3 枚目は 2 枚目のカードに吸い込まれ、2 列ぶんの見開きになる
    await expect(page.locator('[data-testid="merge-card"]')).toHaveCount(4);
    await expect(card(page, 1)).toHaveAttribute("data-kind", "joined");
    await expect(card(page, 1).getByTestId("merge-undo")).toHaveText("解く");
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 組を 1 ページに結合します → 全 4 ページ",
    );

    // Assert - 右綴じなので、次のページ（3 枚目）が左に並ぶ
    const partner = await card(page, 1)
      .getByTestId("merge-partner-image")
      .boundingBox();
    const own = await card(page, 1).getByTestId("merge-image").boundingBox();
    expect(partner!.x, "次のページが左に並んでいない").toBeLessThan(own!.x);

    // Act - 解く
    await card(page, 1).getByTestId("merge-undo").click();

    // Assert
    await expect(page.locator('[data-testid="merge-card"]')).toHaveCount(5);
    await expect(page.getByTestId("split-status")).toHaveText(
      "変更はありません",
    );
  });

  test("保存すると 1 枚の見開きになり、①の「すべて分割」の対象にならない", async ({
    page,
  }) => {
    // Arrange - ①の対象が無い本は②から開く
    const archive = writeBook("結合する.zip", SINGLES_ONLY);
    await open(page, archive, 4);

    // Act
    await card(page, 1).getByTestId("split-merge").click();
    await page.getByTestId("split-confirm").click();

    // Assert - 報告と、読み直した画面
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 組を 1 ページに結合しました（全 3 ページ）",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("split-page-count")).toHaveText("3 ページ");
    await expect(page.locator('[data-testid="merge-card"]')).toHaveCount(3);
    await expect(card(page, 1).getByTestId("merge-kept-whole")).toHaveText(
      "見開き",
    );
    await expect(page.getByTestId("split-confirm")).toBeDisabled();

    // Assert - 結合した見開きは①の対象にしない（#151 #153）。対象にすると、
    // ①の「すべて分割」が②で結合したものを壊す。分けたければ手で選べる
    await expect(page.getByTestId("split-step-split")).toHaveText(
      "① 単ページにする",
    );
    await page.getByTestId("split-step-split").click();
    const spread = page.locator('[data-testid="split-card"][data-index="1"]');
    await expect(spread).toHaveAttribute("data-target", "false");
    await expect(spread.getByTestId("split-kept-whole")).toHaveText("見開き");
    await expect(page.getByTestId("split-all")).toBeDisabled();
    await spread.getByTestId("split-check").click();
    await expect(spread).toHaveAttribute("data-checked", "true");

    // Assert - ZIP の中身。2 ページ目が 1200 幅の 1 枚になり、右に先の
    // ページ（緑）、左に次のページ（青）
    const sizes = Object.values(pageSizesOf(archive));
    expect(sizes).toEqual([
      [600, 900],
      [1200, 900],
      [600, 900],
    ]);
    const merged = Object.keys(pageSizesOf(archive))[1];
    expect(coloursOf(archive)[merged], "左上が次のページの色でない").toBe(
      "#0000ff",
    );
  });
});

/**
 * 1 枚の絵（横縞に左右のグラデーション）を 2 ページに分けて入れた本。
 * 先のページ（右半分）・次のページ（左半分）・無地の単ページの順。
 * withSpread なら、最後に横長の 1 枚（分割の提案が出る）を足す
 */
function writeSeamBook(name: string, withSpread = false): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `
import io, sys, zipfile
from PIL import Image

width, height = 1200, 900
across = Image.linear_gradient("L").rotate(90).resize((width, height))
stripes = Image.new("L", (width, height))
for index, value in enumerate((0, 200, 40, 240, 80, 160, 20, 220, 120)):
    stripes.paste(value, (0, index * 100, width, (index + 1) * 100))
spread = Image.merge("RGB", (across, stripes, Image.new("L", (width, height), 128)))

def png(image):
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()

pages = [
    spread.crop((600, 0, 1200, 900)),
    spread.crop((0, 0, 600, 900)),
    Image.new("RGB", (600, 900), "#808080"),
]
if sys.argv[2] == "1":
    pages.append(Image.new("RGB", (1200, 900), "#404040"))
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    for index, image in enumerate(pages, 1):
        archive.writestr(f"{index:03d}.png", png(image))
`,
    target,
    withSpread ? "1" : "0",
  );
  return target;
}

test.describe("ページ分割・結合: 結合の候補（#149 #153）", () => {
  test("継ぎ目の色がつながる 2 枚を、結合した姿で候補に出す", async ({
    page,
  }) => {
    // Arrange
    await open(page, writeSeamBook("結合の候補.zip"), 2);

    // Assert - 候補は結合した後の姿（1 枚の見開き）で、まだ 2 ページのまま
    await expect(page.getByTestId("split-step-merge")).toHaveText(
      "② 見開きにする1",
    );
    await expect(card(page, 0)).toHaveAttribute("data-kind", "candidate");
    await expect(card(page, 0).getByTestId("merge-badge")).toHaveText(
      "結合候補",
    );
    await expect(card(page, 0).getByTestId("merge-number")).toHaveText("1–2");
    await expect(page.getByTestId("split-confirm")).toBeDisabled();

    // Act - 結合する
    await card(page, 0).getByTestId("merge-accept").click();

    // Assert
    await expect(card(page, 0)).toHaveAttribute("data-kind", "joined");
    await expect(card(page, 0).getByTestId("merge-badge")).toHaveText(
      "結合する",
    );
    await expect(card(page, 0).getByTestId("merge-number")).toHaveText("1");
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 組を 1 ページに結合します → 全 2 ページ",
    );

    // Act - 解くと候補に戻る
    await card(page, 0).getByTestId("merge-undo").click();

    // Assert
    await expect(card(page, 0)).toHaveAttribute("data-kind", "candidate");
    await expect(page.getByTestId("split-status")).toHaveText(
      "変更はありません",
    );
  });

  test("送りボタンで候補を指し、Enter で結合する。すべて結合もできる", async ({
    page,
  }) => {
    // Arrange
    await open(page, writeSeamBook("キーで結合.zip"), 2);

    // Act - 候補を指して Enter
    await page.getByTestId("split-next").click();
    await expect(card(page, 0)).toHaveAttribute("data-focused", "true");
    await expect(page.getByTestId("split-focus-position")).toHaveText("1 / 1");
    await page.keyboard.press("Enter");

    // Assert
    await expect(card(page, 0)).toHaveAttribute("data-kind", "joined");
    await expect(page.getByTestId("merge-all")).toBeDisabled();

    // Act - 戻してから、すべて結合
    await page.getByTestId("split-reset").click();
    await expect(card(page, 0)).toHaveAttribute("data-kind", "candidate");
    await page.getByTestId("merge-all").click();

    // Assert
    await expect(card(page, 0)).toHaveAttribute("data-kind", "joined");
  });
});

test.describe("ページ分割・結合: ステップの切り替え（#153）", () => {
  test("保存していない変更があるまま切り替えると、確かめてから移る", async ({
    page,
  }) => {
    // Arrange - 横長の 1 枚があるので①から開く
    const archive = writeSeamBook("切り替え.zip", true);
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&mode=split&archive=${encodeURIComponent(archive)}`,
    );
    await expect(page.getByTestId("split-step-split")).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 30_000 },
    );
    await page.getByTestId("split-all").click();
    const dialog = page.getByTestId("step-switch-dialog");

    // Act - ②へ移ろうとして、やめる
    await page.getByTestId("split-step-merge").click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("step-switch-cancel").click();

    // Assert - ①のまま、変更も残る
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("split-step-split")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 枚を 2 ページに分けます → 全 5 ページ",
    );

    // Act - 保存せずに切り替える
    await page.getByTestId("split-step-merge").click();
    await page.getByTestId("step-switch-discard").click();

    // Assert - ②へ移り、変更は消える。本はそのまま
    await expect(page.getByTestId("split-step-merge")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("split-status")).toHaveText(
      "変更はありません",
    );
    expect(Object.keys(pageSizesOf(archive))).toHaveLength(4);

    // Act - ①へ戻って分け、今度は保存して切り替える
    await page.getByTestId("split-step-split").click();
    await page.getByTestId("split-all").click();
    await page.getByTestId("split-step-merge").click();
    await page.getByTestId("step-switch-save").click();

    // Assert - 書き込んでから②へ移る
    await expect(page.getByTestId("split-page-count")).toHaveText("5 ページ", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("split-step-merge")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(Object.keys(pageSizesOf(archive))).toHaveLength(5);
  });
});
