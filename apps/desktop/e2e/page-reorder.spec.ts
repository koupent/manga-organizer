import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

const CORE_DIR = fileURLToPath(new URL("../../../services/core", import.meta.url));

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => {
  sidecar?.stop();
});

/** ZIP の中身をファイル名順で読み出す */
function entriesOf(archive: string): string[] {
  const output = execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      `import sys, zipfile; print("\\n".join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))`,
      archive,
    ],
    { cwd: CORE_DIR, encoding: "utf8" },
  );
  return output.trim().split("\n");
}

/** ページの中身（色）を読み出し、並べ替えが実際に効いたか確かめる */
function coloursOf(archive: string): Record<string, string> {
  const output = execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      `
import io, json, sys, zipfile
from PIL import Image
result = {}
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in sorted(archive.namelist()):
        with Image.open(io.BytesIO(archive.read(name))) as image:
            result[name] = "#%02x%02x%02x" % image.convert("RGB").getpixel((20, 20))
print(json.dumps(result))
`,
      archive,
    ],
    { cwd: CORE_DIR, encoding: "utf8" },
  );
  return JSON.parse(output);
}

test.describe("ページ並べ替え", () => {
  test("サムネイルが並び、ドラッグで入れ替えて ZIP に保存できる", async ({ page }) => {
    // Arrange - 3 ページの ZIP。色でどのページか見分ける
    const archive = writeArchive(sidecar.workDir, "reorder.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
      { name: "003.jpg", color: "#0000ff" },
    ]);
    const before = coloursOf(archive);

    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&archive=${encodeURIComponent(archive)}`,
    );

    // Assert - サムネイルが実際に描画される
    const cards = page.getByTestId("page-card");
    await expect(cards).toHaveCount(3);
    await expect(cards.first()).toHaveAttribute("data-name", "001.jpg");
    const firstThumb = cards.first().locator("img");
    await expect(firstThumb).toHaveJSProperty("naturalWidth", 240);

    // Act - 1 枚目を 3 枚目の位置へドラッグする
    const source = cards.nth(0);
    const target = cards.nth(2);
    await source.hover();
    await page.mouse.down();
    const box = await target.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, {
      steps: 12,
    });
    await page.mouse.up();

    // Assert - 画面上の順序が変わり、未保存として示される
    await expect(page.getByTestId("dirty-state")).toHaveText("未保存の変更があります");
    await expect(cards.nth(2)).toHaveAttribute("data-name", "001.jpg");

    // Act - 保存する。dnd-kit はドラッグ直後の 1 クリックを抑止するので、
    // 実際の操作と同じくいったんマウスを離してから押す
    await page.mouse.move(5, 5);
    await page.getByTestId("save").click();
    await expect(page.getByTestId("status")).toContainText("3 ページを並び替えました");

    // Assert - ZIP が実際に書き換わっている
    expect(entriesOf(archive)).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
    const after = coloursOf(archive);
    expect(after["001.jpg"]).toBe(before["002.jpg"]);
    expect(after["002.jpg"]).toBe(before["003.jpg"]);
    expect(after["003.jpg"]).toBe(before["001.jpg"]);
  });

  test("接続情報が無いときは理由を示す", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("error")).toContainText("接続情報がありません");
  });

  test("読めないアーカイブを指定したときは理由を示す", async ({ page }) => {
    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&archive=${encodeURIComponent(sidecar.workDir + "/missing.zip")}`,
    );
    await expect(page.getByTestId("error")).toBeVisible();
  });

  test("表示サイズを変えるとサムネイルの解像度が上がる", async ({ page }) => {
    const archive = writeArchive(sidecar.workDir, "resize.zip", [
      { name: "001.jpg", color: "#123456" },
    ]);
    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&archive=${encodeURIComponent(archive)}`,
    );
    const thumb = page.getByTestId("page-card").first().locator("img");
    await expect(thumb).toHaveJSProperty("naturalWidth", 240);

    await page.getByTestId("card-width").fill("520");
    await expect(thumb).toHaveJSProperty("naturalWidth", 520);
  });
});
