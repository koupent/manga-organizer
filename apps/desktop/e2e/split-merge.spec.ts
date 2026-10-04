import { expect, test, type Page } from "@playwright/test";
import { coloursOf, pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * ページ分割の画面で、隣り合う 2 ページを 1 枚の見開きへ結合する（#139）。
 *
 * 分割と同じく保留にし、確定したときに 1 回だけ書き込む。結合する 2 枚は、
 * 確定する前から結合した後の見開きの姿（右に先のページ、左に次のページ）で出す。
 *
 * 継ぎ目の色がつながる 2 枚は、結合の提案として示す（#149 #151）。
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

async function open(page: Page, archive: string, cards: number) {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=split&archive=${encodeURIComponent(archive)}`,
  );
  await expect(page.locator('[data-testid="split-card"]')).toHaveCount(cards);
}

const card = (page: Page, index: number) =>
  page.locator(`[data-testid="split-card"][data-index="${index}"]`);

test.describe("ページ分割・結合: 2 ページを 1 枚の見開きにする", () => {
  test("結合を選ぶと見開きの姿で出て、やめれば元に戻る", async ({ page }) => {
    // Arrange
    await open(page, writeBook("結合の保留.zip", WITH_SPREAD), 5);
    // 開いた時点では何も保留にしない（#142）
    await expect(page.getByTestId("split-status")).toHaveText(
      "採用する提案を選んでください",
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
    await expect(page.locator('[data-testid="split-card"]')).toHaveCount(4);
    await expect(card(page, 1)).toHaveAttribute("data-merging", "true");
    await expect(card(page, 1)).toHaveAttribute("data-wide", "true");
    await expect(card(page, 1).getByTestId("split-merge")).toHaveText(
      "結合をやめる",
    );
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 組を 1 ページに結合します → 全 4 ページ",
    );

    // Assert - 右綴じなので、次のページ（3 枚目）が左に並ぶ
    const partner = await card(page, 1)
      .getByTestId("split-partner-image")
      .boundingBox();
    const own = await card(page, 1).getByTestId("split-image").boundingBox();
    expect(partner!.x, "次のページが左に並んでいない").toBeLessThan(own!.x);

    // Act - やめる
    await card(page, 1).getByTestId("split-merge").click();

    // Assert
    await expect(page.locator('[data-testid="split-card"]')).toHaveCount(5);
    await expect(page.getByTestId("split-status")).toHaveText(
      "採用する提案を選んでください",
    );
  });

  test("確定すると 1 枚の見開きになり、読み直してもチェックは入らない", async ({
    page,
  }) => {
    // Arrange
    const archive = writeBook("結合する.zip", SINGLES_ONLY);
    await open(page, archive, 4);
    await expect(page.getByTestId("split-status")).toHaveText(
      "変更はありません",
    );

    // Act
    await card(page, 1).getByTestId("split-merge").click();
    await page.getByTestId("split-confirm").click();

    // Assert - 報告と、読み直した画面
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 組を 1 ページに結合しました（全 3 ページ）",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("split-page-count")).toHaveText("3 ページ");
    await expect(page.locator('[data-testid="split-card"]')).toHaveCount(3);

    // Assert - 結合した見開きにはチェックが入らない。入ると、結合した直後に
    // また「割る」が保留になる
    await expect(card(page, 1)).toHaveAttribute("data-wide", "true");
    await expect(card(page, 1)).toHaveAttribute("data-checked", "false");
    await expect(page.getByTestId("split-confirm")).toBeDisabled();

    // Assert - 結合した見開きには分割を提案しない（#151）。自分で結合した
    // ものを、また分けるよう勧めることになる。見開きであることは札で示し、
    // 分けたければ手で選べる
    await expect(card(page, 1).getByTestId("split-kept-whole")).toHaveText(
      "見開きのまま",
    );
    await expect(card(page, 1)).toHaveAttribute("data-proposal", "none");
    await expect(page.getByTestId("split-proposals")).toHaveText(
      "提案はありません",
    );
    await card(page, 1).getByTestId("split-check").click();
    await expect(card(page, 1)).toHaveAttribute("data-checked", "true");

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

test.describe("ページ分割・結合: 結合の提案（#149 #151）", () => {
  test("継ぎ目の色がつながる 2 枚を、結合した姿で提案する", async ({
    page,
  }) => {
    // Arrange
    await open(page, writeSeamBook("結合の提案.zip"), 2);

    // Assert - 開いた時点では何も採用せず、提案の数と次にすることを言う
    await expect(page.getByTestId("split-proposals")).toHaveText(
      "結合 1 の提案",
    );
    await expect(page.getByTestId("split-status")).toHaveText(
      "採用する提案を選んでください",
    );
    await expect(page.getByTestId("split-confirm")).toBeDisabled();

    // Assert - 提案は結合した後の姿（1 枚の見開き）で、まだ 2 ページのまま
    await expect(card(page, 0)).toHaveAttribute("data-proposal", "merge");
    await expect(card(page, 0)).toHaveAttribute("data-proposal-state", "open");
    await expect(card(page, 0)).toHaveAttribute("data-merging", "true");
    await expect(card(page, 0).getByTestId("split-proposal")).toHaveText(
      "結合の提案",
    );
    await expect(card(page, 0).getByTestId("split-number")).toHaveText("1–2");

    // Act - 採用する
    await card(page, 0).getByTestId("split-accept").click();

    // Assert
    await expect(card(page, 0)).toHaveAttribute(
      "data-proposal-state",
      "accepted",
    );
    await expect(card(page, 0).getByTestId("split-proposal")).toHaveText(
      "結合します",
    );
    await expect(card(page, 0).getByTestId("split-number")).toHaveText("1");
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 組を 1 ページに結合します → 全 2 ページ",
    );

    // Act - 「変更を戻す」で未決へ戻し、今度は「このまま」と答える
    await page.getByTestId("split-reset").click();
    await card(page, 0).getByTestId("split-decline").click();

    // Assert - 2 枚は別々のカードに戻り、提案に戻す操作だけが残る
    await expect(page.locator('[data-testid="split-card"]')).toHaveCount(3);
    await expect(card(page, 0)).toHaveAttribute(
      "data-proposal-state",
      "declined",
    );
    await expect(card(page, 0).getByTestId("split-proposal")).toHaveCount(0);
    await expect(page.getByTestId("split-status")).toHaveText(
      "変更はありません",
    );
    await expect(page.getByTestId("split-accept-all")).toBeDisabled();

    // Act - 提案に戻す
    await card(page, 0).getByTestId("split-reopen").click();

    // Assert
    await expect(card(page, 0)).toHaveAttribute("data-proposal-state", "open");
    await expect(page.getByTestId("split-accept-all")).toBeEnabled();
  });

  test("送りボタンで提案を指し、Enter で採用・Backspace でこのまま", async ({
    page,
  }) => {
    // Arrange - 結合の提案 1 組と、分割の提案 1 枚
    await open(page, writeSeamBook("キーで答える.zip", true), 3);
    await expect(page.getByTestId("split-proposals")).toHaveText(
      "分割 1・結合 1 の提案",
    );

    // Act - 最初の提案を指す
    await page.getByTestId("split-next").click();

    // Assert
    await expect(card(page, 0)).toHaveAttribute("data-focused", "true");
    await expect(page.getByTestId("split-focus-position")).toHaveText("1 / 2");

    // Act - Enter で採用すると、次の提案へ進む
    await page.keyboard.press("Enter");

    // Assert
    await expect(card(page, 0)).toHaveAttribute(
      "data-proposal-state",
      "accepted",
    );
    await expect(card(page, 3)).toHaveAttribute("data-focused", "true");
    await expect(page.getByTestId("split-focus-position")).toHaveText("2 / 2");

    // Act - Backspace で「このまま」
    await page.keyboard.press("Backspace");

    // Assert - 断った提案は残り、結合だけが保留になる
    await expect(card(page, 3)).toHaveAttribute(
      "data-proposal-state",
      "declined",
    );
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 組を 1 ページに結合します → 全 3 ページ",
    );
  });

  test("すべて採用は、答えていない提案だけを採用する", async ({ page }) => {
    // Arrange
    await open(page, writeSeamBook("すべて採用.zip", true), 3);
    await card(page, 3).getByTestId("split-decline").click();

    // Act
    await page.getByTestId("split-accept-all").click();

    // Assert - 結合は採用され、断った分割はそのまま
    await expect(card(page, 0)).toHaveAttribute(
      "data-proposal-state",
      "accepted",
    );
    await expect(card(page, 3)).toHaveAttribute(
      "data-proposal-state",
      "declined",
    );
    await expect(page.getByTestId("split-accept-all")).toBeDisabled();
  });
});
