import { expect, test, type Page } from "@playwright/test";
import { pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * ページ並べ替えで崩れた、割った見開きの対を戻せること（#133）。
 *
 * 割った 2 枚を並べ替えで離したり入れ替えたりすると、以前はただの 2 ページに
 * 見え、ZIP に元画像が残っているのに戻せなかった。対は記録（中身のハッシュ）
 * から引けるので、並びに関係なく 1 枚の見開きとして出す。
 *
 * サイドカー側の契約は `services/core/tests/test_page_splitter.py` と
 * `test_split_api.py` の `SeparatedPairTest`。
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/**
 * 3 枚目が見開きの本を割り、並べ替えで左半分を末尾へ動かす。
 * order は割った後の 5 ページの並べ方（0 始まり）。
 */
function writeMovedPair(name: string, order: number[]): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `
import io, json, sys, zipfile
from pathlib import Path
from PIL import Image
from manga_core.page_reorder import ZipPageEditor
from manga_core.page_splitter import SplitIntent, SplitPosition, apply_rows, scan_rows

def flat(width, height, colour):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, "PNG")
    return buffer.getvalue()

spread = Image.new("RGB", (2400, 1800), "#ff2020")
spread.paste(Image.new("RGB", (1200, 1800), "#2020ff"), (1200, 0))
buffer = io.BytesIO()
spread.save(buffer, "PNG")

target = Path(sys.argv[1])
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("001.png", flat(1200, 1800, "#00ff00"))
    archive.writestr("002.png", flat(1200, 1800, "#ffff00"))
    archive.writestr("003.png", buffer.getvalue())
    archive.writestr("004.png", flat(1200, 1800, "#00ffff"))

apply_rows(
    target,
    [
        SplitIntent(names=row.names, split=SplitPosition(x=1300) if row.is_spread else None)
        for row in scan_rows(target)
    ],
)
editor = ZipPageEditor(target)
names = [page.name for page in editor.pages]
editor.apply_order([names[index] for index in json.loads(sys.argv[2])])
editor.close()
`,
    target,
    JSON.stringify(order),
  );
  return target;
}

async function open(page: Page, archive: string) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=split&archive=${encodeURIComponent(archive)}`,
  );
  // 離れた対がある本は①から開く。入れ替えただけの対の本は②から開くので、
  // ①へ移る（#153）
  await page.getByTestId("split-step-split").click();
  await expect(page.locator('[data-testid="split-card"]')).toHaveCount(5, {
    timeout: 30_000,
  });
}

const card = (page: Page, index: number) =>
  page.locator(`[data-testid="split-card"][data-index="${index}"]`).first();

test.describe("ページ分割: 崩れた対を戻す", () => {
  test("離れた対も同じページ一覧に出て、割る前へ戻せる", async ({ page }) => {
    // Arrange - 割った 5 ページのうち、左半分（4 枚目）を末尾へ
    const archive = writeMovedPair("離れた対.zip", [0, 1, 2, 4, 3]);

    // Act
    await open(page, archive);

    // Assert - 分割した2枚を同じ一覧に出す。隣り合わせに動くことは、
    // 開いた時点で保留として見えている
    await expect(card(page, 2)).toHaveAttribute("data-checked", "true");
    await expect(card(page, 2).getByTestId("split-number")).toHaveAttribute(
      "data-pending",
      "true",
    );
    await expect(page.getByTestId("split-status")).toContainText(
      "離れた見開き 1 組を隣り合わせに戻します",
    );

    // Act - チェックを外して割る前へ戻す
    await card(page, 2).getByTestId("split-check").click();
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toContainText(
      "1 枚を 1 ページに戻しました",
      { timeout: 30_000 },
    );

    // Assert - 3 ページ目に元の見開きが戻り、4 ページの本になる
    expect(Object.values(pageSizesOf(archive))).toEqual([
      [1200, 1800],
      [1200, 1800],
      [2400, 1800],
      [1200, 1800],
    ]);
  });

  test("左右を入れ替えた対も保存済みのページとして出る", async ({ page }) => {
    // Arrange - 右半分と左半分を入れ替える
    const archive = writeMovedPair("入れ替えた対.zip", [0, 1, 3, 2, 4]);

    // Act
    await open(page, archive);

    // Assert - 畳まれて、触らなければ何も変わらない
    await expect(card(page, 2)).toHaveAttribute("data-checked", "true");
    await expect(card(page, 2).getByTestId("split-number")).toHaveAttribute(
      "data-pending",
      "false",
    );
    await expect(page.getByTestId("split-status")).toHaveText(
      "変更はありません",
    );
  });
});
