import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { startSidecar, type Sidecar } from "./sidecar";

const CORE_DIR = fileURLToPath(new URL("../../../services/core", import.meta.url));

let sidecar: Sidecar;
test.beforeAll(async () => { sidecar = await startSidecar(); });
test.afterAll(() => sidecar?.stop());

/** 表紙が見開き（左右で色が違う）の ZIP を作る */
function writeSpreadArchive(workDir: string, name: string): string {
  const target = `${workDir}/${name}`;
  execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      `
import io, sys, zipfile
from PIL import Image
target = sys.argv[1]
spread = Image.new("RGB", (1600, 1200), "#ff0000")
spread.paste(Image.new("RGB", (800, 1200), "#0000ff"), (800, 0))
buffer = io.BytesIO()
spread.save(buffer, "JPEG", quality=95)
page = io.BytesIO()
Image.new("RGB", (800, 1200), "#888888").save(page, "JPEG")
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("001.jpg", buffer.getvalue())
    archive.writestr("002.jpg", page.getvalue())
`,
      target,
    ],
    { cwd: CORE_DIR },
  );
  return target;
}

async function openCover(page: import("@playwright/test").Page, archive: string) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=cover&archive=${encodeURIComponent(archive)}`,
  );
}

test.describe("表紙加工", () => {
  test("見開きを検出し、分割すると 2:3 に収まる", async ({ page }) => {
    // Arrange
    const archive = writeSpreadArchive(sidecar.workDir, "cover.zip");
    await openCover(page, archive);

    // Assert - 見開きとして警告される
    await expect(page.getByTestId("cover-name")).toHaveText("001.jpg");
    await expect(page.getByTestId("cover-size")).toHaveText("1600×1200");
    await expect(page.getByTestId("spread-warning")).toBeVisible();

    // Act - 右半分を表紙にする
    await page.getByTestId("split-right").click();
    await expect(page.getByTestId("cover-status")).toContainText("加工しました", {
      timeout: 30_000,
    });

    // Assert - 見開きでなくなり、viewer の枠に収まる
    await expect(page.getByTestId("cover-size")).toHaveText("800×1200");
    await expect(page.getByTestId("spread-warning")).toBeHidden();
    await expect(page.getByTestId("fits-frame")).toHaveText("枠に合っています");
  });

  test("加工後の表紙が実際に差し替わっている", async ({ page }) => {
    // Arrange
    const archive = writeSpreadArchive(sidecar.workDir, "replace.zip");
    await openCover(page, archive);
    await page.getByTestId("split-right").click();
    await expect(page.getByTestId("cover-status")).toContainText("加工しました", {
      timeout: 30_000,
    });

    // Assert - 残ったのは右半分（青）で、他ページは無変更
    const inspected = execFileSync(
      "uv",
      [
        "run",
        "python",
        "-c",
        `
import io, json, sys, zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    with Image.open(io.BytesIO(archive.read("001.jpg"))) as cover:
        red, green, blue = cover.convert("RGB").getpixel((400, 600))
    with Image.open(io.BytesIO(archive.read("002.jpg"))) as other:
        size = other.size
print(json.dumps({"names": names, "blue_wins": blue > red, "other": size}))
`,
        archive,
      ],
      { cwd: CORE_DIR, encoding: "utf8" },
    );
    const result = JSON.parse(inspected);
    expect(result.names).toEqual(["001.jpg", "002.jpg"]);
    expect(result.blue_wins).toBeTruthy();
    expect(result.other).toEqual([800, 1200]);
  });

  test("90 度回すと縦横が入れ替わる", async ({ page }) => {
    const archive = writeSpreadArchive(sidecar.workDir, "rotate.zip");
    await openCover(page, archive);

    await page.getByTestId("rotate").click();
    await expect(page.getByTestId("cover-status")).toContainText("加工しました", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("cover-size")).toHaveText("1200×1600");
  });
});
