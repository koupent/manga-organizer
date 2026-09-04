import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

const CORE_DIR = fileURLToPath(
  new URL("../../../services/core", import.meta.url),
);

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
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

/** サムネイル作成の画面を開く。mode の id は thumbnail */
async function openCover(
  page: import("@playwright/test").Page,
  archive: string,
) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=thumbnail&archive=${encodeURIComponent(archive)}`,
  );
}

test.describe("サムネイル作成", () => {
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
    await expect(page.getByTestId("cover-status")).toContainText(
      "加工しました",
      {
        timeout: 30_000,
      },
    );

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
    await expect(page.getByTestId("cover-status")).toContainText(
      "加工しました",
      {
        timeout: 30_000,
      },
    );

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
    await expect(page.getByTestId("cover-status")).toContainText(
      "加工しました",
      {
        timeout: 30_000,
      },
    );
    await expect(page.getByTestId("cover-size")).toHaveText("1200×1600");
  });
});

/** ZIP の中身をファイル名順で読み出す（page-reorder.spec.ts と同じ手） */
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

/** ページの中身（色）を読み出し、加工が実際に効いたか確かめる */
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

/** 検証用に塗り分ける色。加工で再圧縮されるので、名前で見分ける */
const PALETTE: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
};

/** 画素に最も近い色名。JPEG の再圧縮でずれても同じ絵だと分かるようにする */
function nearestColour(hex: string): string {
  const pixel = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return Object.keys(PALETTE).reduce((best, name) => {
    const distance = (candidate: string) =>
      PALETTE[candidate].reduce(
        (sum, value, index) => sum + (value - pixel[index]) ** 2,
        0,
      );
    return distance(name) < distance(best) ? name : best;
  }, "red");
}

/** ページの色名を viewer と同じ辞書順で返す。どの絵が何ページ目かを見る */
function pageColours(archive: string): string[] {
  const colours = coloursOf(archive);
  return Object.keys(colours)
    .sort()
    .map((name) => nearestColour(colours[name]));
}

test.describe("サムネイル作成の対象選択と加工", () => {
  /**
   * 実際のドロップを再現する。
   *
   * ブラウザは実パスを渡さないので、名前とサイズだけを持つ File を作って
   * drop イベントを投げる。アプリはその手がかりから実パスを引き当てる。
   * （e2e/drop.spec.ts と同じ経路）
   */
  async function dropFiles(
    page: Page,
    files: { name: string; size: number }[],
  ) {
    await page.dispatchEvent('[data-testid="dropzone"]', "drop", {
      dataTransfer: await page.evaluateHandle((entries) => {
        const transfer = new DataTransfer();
        for (const entry of entries) {
          transfer.items.add(
            new File([new Uint8Array(entry.size)], entry.name, {
              type: "application/zip",
            }),
          );
        }
        return transfer;
      }, files),
    });
  }

  /** 作った ZIP を、ドロップに渡す名前とサイズの組にする */
  function dropEntry(archive: string) {
    return {
      name: archive.split("/").pop()!,
      size: readFileSync(archive).length,
    };
  }

  /** 対象を選ばずにサムネイル作成を開く */
  async function openThumbnail(page: Page) {
    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&mode=thumbnail`,
    );
    await expect(page.getByTestId("mode-thumbnail")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }

  /**
   * ファイルブラウザを辿って対象を 1 件選ぶ。
   *
   * page-reorder.spec.ts と同じ要領で、実パスはサーバー側が返す。
   */
  async function chooseArchiveViaBrowser(page: Page, archive: string) {
    const name = archive.split("/").pop()!;
    await page.getByTestId("open-browser").click();
    await expect(page.getByTestId("file-browser")).toBeVisible();
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${name}"] .browser-name`,
      )
      .click();
  }

  /** 色を塗り分けた 3 ページの ZIP。どの絵が何ページ目かを中身から見分ける。
   * 連番でない名前にして、先頭移動に伴う振り直しが起きたかどうかも見えるようにする */
  function writePages(name: string): string {
    return writeArchive(sidecar.workDir, name, [
      { name: "page-a.jpg", color: "#ff0000" },
      { name: "page-b.jpg", color: "#00ff00" },
      { name: "page-c.jpg", color: "#0000ff" },
    ]);
  }

  /**
   * ページごとに寸法が違う ZIP を作る。
   *
   * 名前の表示を差し替えただけでも通ってしまわないよう、選んだ画像を実際に
   * 読み直したかどうかを寸法で確かめられるようにする。どのページも 2:3 では
   * ないので、2:3 の枠には必ず余りができ、動かせる。
   */
  function writeSizedArchive(name: string, prefix = "page"): string {
    const target = `${sidecar.workDir}/${name}`;
    execFileSync(
      "uv",
      [
        "run",
        "python",
        "-c",
        `
import io, sys, zipfile
from PIL import Image
prefix = sys.argv[2]
sizes = [("a", (900, 900), "#ff0000"),
         ("b", (800, 1000), "#00ff00"),
         ("c", (700, 1100), "#0000ff")]
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    for suffix, size, color in sizes:
        buffer = io.BytesIO()
        Image.new("RGB", size, color).save(buffer, "JPEG", quality=90)
        archive.writestr(f"{prefix}-{suffix}.jpg", buffer.getvalue())
`,
        target,
        prefix,
      ],
      { cwd: CORE_DIR },
    );
    return target;
  }

  /** 枠の位置と大きさ。動いたかどうかを実際の描画から見る */
  async function frameBox(page: Page) {
    const box = await page.getByTestId("crop-frame").boundingBox();
    if (!box) throw new Error("crop-frame が描画されていません");
    return box;
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

  test("対象が選ばれていないときはドロップ領域が出る", async ({ page }) => {
    // Arrange / Act
    await openThumbnail(page);

    // Assert - その場で投入できる場所と、辿って選ぶ入口がある
    await expect(page.getByTestId("dropzone")).toBeVisible();
    await expect(page.getByTestId("open-browser")).toBeVisible();
  });

  test("ドロップした ZIP の先頭ページが加工対象になる", async ({ page }) => {
    // Arrange
    const archive = writePages("サムネイル投入.zip");
    await openThumbnail(page);

    // Act
    await dropFiles(page, [dropEntry(archive)]);

    // Assert - 落とした 1 件が対象になり、既定で先頭ページが選ばれている
    await expect(page.getByTestId("thumbnail-archive-name")).toHaveText(
      "サムネイル投入.zip",
    );
    await expect(page.getByTestId("cover-name")).toHaveText("page-a.jpg");
    await expect(page.getByTestId("cover-size")).toHaveText("600×900");
  });

  test("複数まとめて落としたら先頭の 1 件だけを対象にする", async ({
    page,
  }) => {
    // Arrange - ページ名を変えて、どちらが対象か中身からも分かるようにする
    const head = writePages("サムネイルまとめ 先頭.zip");
    const tail = writeArchive(sidecar.workDir, "サムネイルまとめ 後続.zip", [
      { name: "tail-a.jpg", color: "#ffff00" },
    ]);
    await openThumbnail(page);

    // Act
    await dropFiles(page, [dropEntry(head), dropEntry(tail)]);

    // Assert
    await expect(page.getByTestId("thumbnail-archive-name")).toHaveText(
      "サムネイルまとめ 先頭.zip",
    );
    await expect(page.getByTestId("cover-name")).toHaveText("page-a.jpg");
  });

  test("ファイルを選ぶボタンから辿って対象にできる", async ({ page }) => {
    // Arrange
    const archive = writePages("サムネイル ブラウザ.zip");
    await openThumbnail(page);

    // Act
    await chooseArchiveViaBrowser(page, archive);

    // Assert
    await expect(page.getByTestId("thumbnail-archive-name")).toHaveText(
      "サムネイル ブラウザ.zip",
    );
    await expect(page.getByTestId("cover-name")).toHaveText("page-a.jpg");
  });

  test("サムネイルにする画像を選び直せる", async ({ page }) => {
    // Arrange - 既定では先頭が選ばれている。寸法で本当に読み直したか見る
    const archive = writeSizedArchive("サムネイル選択.zip");
    await openCover(page, archive);
    await expect(page.getByTestId("cover-name")).toHaveText("page-a.jpg");
    await expect(page.getByTestId("cover-size")).toHaveText("900×900");

    // Act - アーカイブ内の画像から 2 枚目を選ぶ
    await page.getByTestId("choose-page").click();
    const candidates = page.getByTestId("thumbnail-candidate");
    await expect(candidates).toHaveCount(3);
    await expect(candidates.first()).toHaveAttribute("data-name", "page-a.jpg");
    await page
      .locator('[data-testid="thumbnail-candidate"][data-name="page-b.jpg"]')
      .click();

    // Assert - 加工画面が選んだ画像に切り替わる
    await expect(page.getByTestId("cover-name")).toHaveText("page-b.jpg");
    await expect(page.getByTestId("cover-size")).toHaveText("800×1000");
  });

  test("2:3 の枠をドラッグして位置を変えられる", async ({ page }) => {
    // Arrange - 横長の表紙なら枠の左右に余りがあり、動かせる
    const archive = writeSpreadArchive(sidecar.workDir, "枠移動.zip");
    await openCover(page, archive);
    const before = await frameBox(page);

    // Act - 枠の真ん中を掴んで右へ運ぶ
    const centre = {
      x: before.x + before.width / 2,
      y: before.y + before.height / 2,
    };
    await dragFrom(page, centre, { x: centre.x + 60, y: centre.y });

    // Assert - 位置だけが動く。大きさは変わらない
    const after = await frameBox(page);
    expect(after.x - before.x).toBeGreaterThan(20);
    expect(Math.abs(after.y - before.y)).toBeLessThan(3);
    expect(Math.abs(after.width - before.width)).toBeLessThan(3);
    expect(Math.abs(after.height - before.height)).toBeLessThan(3);
  });

  test("枠を動かしても初期状態へ戻せる", async ({ page }) => {
    // Arrange
    const archive = writeSpreadArchive(sidecar.workDir, "枠戻し.zip");
    await openCover(page, archive);
    const initial = await frameBox(page);

    // Act - いったん動かしてから戻す
    const centre = {
      x: initial.x + initial.width / 2,
      y: initial.y + initial.height / 2,
    };
    await dragFrom(page, centre, { x: centre.x + 60, y: centre.y });
    expect((await frameBox(page)).x).not.toBe(initial.x);
    await page.getByTestId("crop-reset").click();

    // Assert
    const reset = await frameBox(page);
    expect(Math.abs(reset.x - initial.x)).toBeLessThan(3);
    expect(Math.abs(reset.width - initial.width)).toBeLessThan(3);
  });

  test("枠の縦横比が 2:3 に保たれる", async ({ page }) => {
    // Arrange - viewer が表紙を 2:3 で描くため、枠も 2:3 に固定する
    const archive = writeSpreadArchive(sidecar.workDir, "枠比率.zip");
    await openCover(page, archive);
    const before = await frameBox(page);
    expect(Math.abs(before.width / before.height - 2 / 3)).toBeLessThan(0.02);

    // Act - 掴む所を枠の内側へ運んで小さくする
    const handle = await page.getByTestId("crop-handle").first().boundingBox();
    if (!handle) throw new Error("crop-handle が描画されていません");
    const grip = {
      x: handle.x + handle.width / 2,
      y: handle.y + handle.height / 2,
    };
    const towards = {
      x: before.x + before.width / 2 - grip.x,
      y: before.y + before.height / 2 - grip.y,
    };
    const length = Math.hypot(towards.x, towards.y) || 1;
    await dragFrom(page, grip, {
      x: grip.x + (towards.x / length) * 60,
      y: grip.y + (towards.y / length) * 60,
    });

    // Assert - 実際に小さくなり、それでも比率は 2:3 のまま
    const after = await frameBox(page);
    expect(after.width).toBeLessThan(before.width - 15);
    expect(Math.abs(after.width / after.height - 2 / 3)).toBeLessThan(0.02);
  });

  test("確定すると選んだ画像が先頭ページになる", async ({ page }) => {
    // Arrange - 色でどの絵か見分ける
    const archive = writePages("サムネイル確定.zip");
    expect(pageColours(archive)).toEqual(["red", "green", "blue"]);
    await openCover(page, archive);

    // Act - 2 枚目を選んで確定する
    await page.getByTestId("choose-page").click();
    await page
      .locator('[data-testid="thumbnail-candidate"][data-name="page-b.jpg"]')
      .click();
    await expect(page.getByTestId("cover-name")).toHaveText("page-b.jpg");
    await page.getByTestId("apply-thumbnail").click();
    await expect(page.getByTestId("cover-status")).toContainText(
      "加工しました",
      { timeout: 30_000 },
    );

    // Assert - 選んだ絵が先頭に来て、ページ数は変わらない
    const entries = entriesOf(archive);
    expect(entries).toHaveLength(3);
    expect(entries).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
    expect(pageColours(archive)).toEqual(["green", "red", "blue"]);
  });

  test("別のファイルを選び直すと加工の状態が持ち越されない", async ({
    page,
  }) => {
    // Arrange - 2 つ目はページ名を変えて、どちらを見ているか分かるようにする。
    // どちらも 2:3 でない寸法にして、枠に動かせる余りを作る
    const first = writeSizedArchive("サムネイル選び直し 1.zip");
    const second = writeSizedArchive("サムネイル選び直し 2.zip", "cover");
    await openCover(page, first);

    // Arrange - 1 つ目で 2 枚目を選び、枠も動かして状態を作る
    await page.getByTestId("choose-page").click();
    await page
      .locator('[data-testid="thumbnail-candidate"][data-name="page-b.jpg"]')
      .click();
    await expect(page.getByTestId("cover-name")).toHaveText("page-b.jpg");
    const moved = await frameBox(page);
    await dragFrom(
      page,
      { x: moved.x + moved.width / 2, y: moved.y + moved.height / 2 },
      { x: moved.x + moved.width / 2 + 40, y: moved.y + moved.height / 2 },
    );
    expect((await frameBox(page)).x).not.toBe(moved.x);

    // Act - 2 つ目に選び直す
    await page.getByTestId("change-archive").click();
    await expect(page.getByTestId("dropzone")).toBeVisible();
    await chooseArchiveViaBrowser(page, second);

    // Assert - 選んだ画像は 2 つ目の先頭に戻る
    await expect(page.getByTestId("thumbnail-archive-name")).toHaveText(
      "サムネイル選び直し 2.zip",
    );
    await expect(page.getByTestId("cover-name")).toHaveText("cover-a.jpg");
    await expect(page.getByTestId("cover-size")).toHaveText("900×900");

    // Assert - 枠も初期状態。戻す操作をしても動かない
    const carried = await frameBox(page);
    await page.getByTestId("crop-reset").click();
    const reset = await frameBox(page);
    expect(Math.abs(carried.x - reset.x)).toBeLessThan(3);
    expect(Math.abs(carried.width - reset.width)).toBeLessThan(3);
  });
});
