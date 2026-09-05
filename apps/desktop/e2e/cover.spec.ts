import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  VIEWER_CONTRACT_IMPORT,
  coloursOf,
  pageEntriesOf,
  runPython,
  storedOriginalsOf,
} from "./archive";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 表紙が見開き（左右で色が違う）の ZIP を作る */
function writeSpreadArchive(workDir: string, name: string): string {
  const target = `${workDir}/${name}`;
  runPython(
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
  );
  return target;
}

/**
 * 細かいノイズを載せた見開きの ZIP を作る。
 *
 * JPEG は保存し直すたびに劣化する。一様な色だと何度書き直しても画素が
 * ほとんど動かず、「押すたびに書き換わる」ことを中身から捉えられない。
 * ノイズを載せておけば、何回書き直されたかが画素の差として残る。
 * 左右の色は残し、見え方でも向きが分かるようにする。
 */
function writeNoisyArchive(workDir: string, name: string): string {
  const target = `${workDir}/${name}`;
  runPython(
    `
import io, random, sys, zipfile
from PIL import Image
rnd = random.Random(7)
base = Image.new("RGB", (1600, 1200), "#ff2020")
base.paste(Image.new("RGB", (800, 1200), "#2020ff"), (800, 0))
noise = Image.frombytes("RGB", (1600, 1200), rnd.randbytes(1600 * 1200 * 3))
spread = Image.blend(base, noise, 0.3)
buffer = io.BytesIO()
spread.save(buffer, "JPEG", quality=95)
page = io.BytesIO()
Image.new("RGB", (800, 1200), "#888888").save(page, "JPEG")
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("001.jpg", buffer.getvalue())
    archive.writestr("002.jpg", page.getvalue())
`,
    target,
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

/**
 * 枠の真ん中を掴んで、指定した側の端いっぱいまで運ぶ。
 *
 * 枠は画像の外へは出ないので、窓の内側いっぱいまで運べば端で止まる。
 * 見開き（1600×1200）なら、2:3 の枠がちょうど片側の半分に重なる。
 */
async function dragFrameTo(page: Page, side: "left" | "right") {
  const box = await frameBox(page);
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const viewport = page.viewportSize()!;
  await dragFrom(page, centre, {
    x: side === "right" ? viewport.width - 1 : 1,
    y: centre.y,
  });
}

/**
 * viewer での見え方（cover-frame）に何が見えているかの指紋。
 *
 * 中の作りではなく、描かれた絵そのものを見る。同じ状態なら同じ指紋になる。
 */
async function previewShot(page: Page): Promise<string> {
  const buffer = await page.getByTestId("cover-frame").screenshot();
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

/** 画像の読み込みが終わり、見え方が動かなくなるまで待つ。その指紋を返す */
async function settledPreview(page: Page): Promise<string> {
  let current = await previewShot(page);
  await expect
    .poll(
      async () => {
        const previous = current;
        current = await previewShot(page);
        return current === previous;
      },
      { timeout: 20_000, message: "viewer での見え方が落ち着きません" },
    )
    .toBe(true);
  return current;
}

/**
 * 90 度回し、見え方が変わるまで待つ。
 *
 * 待つ先を見え方に置くのは、押した時点でファイルを書き換える実装でも
 * 保留にする実装でも、同じ合図で待ち切るため。前者ではこの合図が出た時点で
 * 書き込みまで終わっているので、直後にファイルを見れば書き換えを捉えられる。
 */
async function rotateOnce(page: Page, previous: string): Promise<string> {
  await page.getByTestId("rotate").click();
  await expect
    .poll(() => previewShot(page), {
      timeout: 30_000,
      message: "90 度回しても viewer での見え方が変わりません",
    })
    .not.toBe(previous);
  return settledPreview(page);
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
    .locator(`[data-testid="browse-entry"][data-name="${name}"] .browser-name`)
    .click();
}

test.describe("サムネイル作成", () => {
  test("見開きを検出し、片側を切り抜くと 2:3 に収まる", async ({ page }) => {
    // Arrange
    const archive = writeSpreadArchive(sidecar.workDir, "cover.zip");
    await openCover(page, archive);

    // Assert - 見開きとして警告される
    await expect(page.getByTestId("cover-name")).toHaveText("001.jpg");
    await expect(page.getByTestId("cover-size")).toHaveText("1600×1200");
    await expect(page.getByTestId("spread-warning")).toBeVisible();

    // Act - 2:3 の枠を右半分へ寄せて確定する。
    // 見開きの表紙は、使いたい側へ枠を合わせれば表紙になる
    await dragFrameTo(page, "right");
    await page.getByTestId("apply-thumbnail").click();
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

  test("切り抜いた表紙が実際に差し替わっている", async ({ page }) => {
    // Arrange
    const archive = writeSpreadArchive(sidecar.workDir, "replace.zip");
    await openCover(page, archive);
    await expect(page.getByTestId("cover-size")).toHaveText("1600×1200");

    // Act - 右半分（青）へ枠を寄せて確定する
    await dragFrameTo(page, "right");
    await page.getByTestId("apply-thumbnail").click();
    await expect(page.getByTestId("cover-status")).toContainText(
      "加工しました",
      {
        timeout: 30_000,
      },
    );

    // Assert - 残ったのは右半分（青）で、他ページは無変更
    const inspected = runPython(
      `
import io, json, sys, zipfile
from PIL import Image
${VIEWER_CONTRACT_IMPORT}
with zipfile.ZipFile(sys.argv[1]) as archive:
    pages = sorted(n for n in archive.namelist() if is_viewer_page(n))
    with Image.open(io.BytesIO(archive.read("001.jpg"))) as opened:
        cover = opened.convert("RGB")
        size = cover.size
        red, green, blue = cover.getpixel((cover.width // 4, cover.height // 4))
    with Image.open(io.BytesIO(archive.read("002.jpg"))) as other:
        other_size = other.size
print(json.dumps({"pages": pages, "size": size,
                  "blue_wins": blue > red, "other": other_size}))
`,
      archive,
    );
    const result = JSON.parse(inspected);
    expect(result.pages).toEqual(["001.jpg", "002.jpg"]);
    expect(result.size).toEqual([800, 1200]);
    expect(result.blue_wins).toBeTruthy();
    expect(result.other).toEqual([800, 1200]);

    // Assert - ページ以外として同梱された元画像と記録（#66）も残っている。
    // ページだけを見ていると、同梱そのものが失われても気づけない
    const stored = storedOriginalsOf(archive);
    expect(stored.manifest).toBeTruthy();
    expect(stored.originals).toHaveLength(1);
  });
});

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

/** ZIP の指紋。エントリ名・寸法・中身のハッシュを並べる */
type ArchiveState = {
  name: string;
  size: [number, number] | null;
  digest: string;
}[];

/**
 * ZIP が書き換えられたかどうかを中身から見る。
 *
 * 名前と寸法だけでは、同じ寸法で保存し直された書き換えを見逃す。
 * バイト列そのものをハッシュして、1 バイトの違いも捉える。
 *
 * ハッシュはページ以外（#66 の元画像や manifest）も含めた全エントリで取る。
 * ページだけに絞ると、確定前に manifest を書いてしまう作りを見逃す。
 * 寸法は画像にしか無いので、ページ以外は null にする。ページでない
 * manifest.json を Image.open すると、そこで落ちて比較まで届かない。
 */
function archiveState(archive: string): ArchiveState {
  const output = runPython(
    `
import hashlib, io, json, sys, zipfile
from PIL import Image
${VIEWER_CONTRACT_IMPORT}
result = []
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in sorted(archive.namelist()):
        data = archive.read(name)
        size = None
        if is_viewer_page(name):
            with Image.open(io.BytesIO(data)) as image:
                size = list(image.size)
        result.append({"name": name, "size": size,
                       "digest": hashlib.sha256(data).hexdigest()[:16]})
print(json.dumps(result))
`,
    archive,
  );
  return JSON.parse(output);
}

/**
 * 先頭ページの寸法と四隅寄りの色。どちらを向いているかを中身から見分ける。
 *
 * 左右で色が違う見開きなら、回っていなければ上下の 2 点が同じ色になり、
 * 90 度回っていれば左右の 2 点が同じ色になる。切り抜きの範囲に左右されない。
 */
function firstPageProfile(archive: string): {
  name: string;
  size: [number, number];
  corners: string[];
} {
  const output = runPython(
    `
import io, json, sys, zipfile
from PIL import Image
${VIEWER_CONTRACT_IMPORT}
with zipfile.ZipFile(sys.argv[1]) as archive:
    name = sorted(name for name in archive.namelist() if is_viewer_page(name))[0]
    with Image.open(io.BytesIO(archive.read(name))) as opened:
        image = opened.convert("RGB")
        width, height = image.size
        spots = [(width // 4, height // 4), (width * 3 // 4, height // 4),
                 (width // 4, height * 3 // 4), (width * 3 // 4, height * 3 // 4)]
        corners = ["#%02x%02x%02x" % image.getpixel(spot) for spot in spots]
print(json.dumps({"name": name, "size": [width, height], "corners": corners}))
`,
    archive,
  );
  const parsed = JSON.parse(output);
  return { ...parsed, corners: parsed.corners.map(nearestColour) };
}

/**
 * 2 つの ZIP の先頭ページを画素で比べる。
 *
 * 同じ加工を 1 回だけ受けた画像どうしなら完全に一致する。書き直しが
 * 重なっていれば、そのぶんだけ平均差（mae）が積み上がる。
 */
function firstPageDiff(
  left: string,
  right: string,
): { sizes: [number, number][]; mae: number | null } {
  const output = runPython(
    `
import io, json, sys, zipfile
from PIL import Image, ImageChops
${VIEWER_CONTRACT_IMPORT}
def first(path):
    with zipfile.ZipFile(path) as archive:
        name = sorted(name for name in archive.namelist() if is_viewer_page(name))[0]
        with Image.open(io.BytesIO(archive.read(name))) as image:
            return image.convert("RGB")
left = first(sys.argv[1])
right = first(sys.argv[2])
out = {"sizes": [list(left.size), list(right.size)], "mae": None}
if left.size == right.size:
    hist = ImageChops.difference(left, right).histogram()
    total = sum(index % 256 * count for index, count in enumerate(hist))
    out["mae"] = total / (left.size[0] * left.size[1] * 3)
print(json.dumps(out))
`,
    left,
    right,
  );
  return JSON.parse(output);
}

/** 1 回ぶんの保存で動く画素差の上限。同じ加工なら本来は完全に一致する */
const SAME_IMAGE_MAE = 0.5;

/** ボタンの位置が動いたとみなす量 */
const BUTTON_SHIFT_TOLERANCE = 4;

/** 加工を押した後、ボタンが動かないかを見張る時間 */
const BUTTON_WATCH_MS = 2_000;

/**
 * 加工は押した瞬間ではなく、確定したときに 1 回だけファイルへ書く。
 *
 * 押すたびに書き換える作りでは、分割や回転が書き換わった画像へ更に重なり、
 * 押した回数だけ画像が壊れる。ここで見るのは「押しても書かない」ことと、
 * 「確定するまで元のファイルが無傷である」ことの 2 つ。
 */
test.describe("サムネイル作成: 加工は確定するまで保留する", () => {
  test("90 度回しても、確定するまでアーカイブは書き換わらない", async ({
    page,
  }) => {
    // Arrange - 開く前の中身を控える
    const archive = writeSpreadArchive(sidecar.workDir, "回転は保留.zip");
    const before = archiveState(archive);
    await openCover(page, archive);
    await expect(page.getByTestId("cover-size")).toHaveText("1600×1200");
    const initial = await settledPreview(page);

    // Act - 90 度回す。見え方が変わるまで待つので、
    // 押した時点で書き込む作りならこの時点で書き込みも済んでいる
    await rotateOnce(page, initial);

    // Assert - ページ名も寸法も中身も、1 バイトも変わっていない
    expect(archiveState(archive)).toEqual(before);

    // Act - 確定する
    await page.getByTestId("apply-thumbnail").click();
    await expect(page.getByTestId("cover-status")).toContainText(
      "加工しました",
      { timeout: 30_000 },
    );

    // Assert - 回転はここで 1 回ぶんだけ効く。
    // 左右に並んでいた赤と青が、上下に並ぶ
    const profile = firstPageProfile(archive);
    expect(profile.corners).toEqual(["red", "red", "blue", "blue"]);
  });

  test("90 度を 4 回押して確定しても、1 回だけ書いたのと同じ画像になる", async ({
    page,
  }) => {
    // Arrange - 中身が同じ 2 つ。片方はそのまま確定し、比べる物差しにする
    const control = writeNoisyArchive(sidecar.workDir, "四回転 対照.zip");
    const spun = writeNoisyArchive(sidecar.workDir, "四回転 実験.zip");
    await openCover(page, control);
    await expect(page.getByTestId("cover-size")).toHaveText("1600×1200");
    await page.getByTestId("apply-thumbnail").click();
    await expect(page.getByTestId("cover-status")).toContainText(
      "加工しました",
      { timeout: 30_000 },
    );

    // Act - もう一方は 90 度を 4 回押してから確定する。1 周して元の向きに戻る
    await openCover(page, spun);
    await expect(page.getByTestId("cover-size")).toHaveText("1600×1200");
    let shot = await settledPreview(page);
    for (let turn = 0; turn < 4; turn += 1) {
      shot = await rotateOnce(page, shot);
    }
    await page.getByTestId("apply-thumbnail").click();
    await expect(page.getByTestId("cover-status")).toContainText(
      "加工しました",
      { timeout: 30_000 },
    );

    // Assert - 向きも寸法も同じで、画素もほぼ一致する。
    // 押すたびに書き直す作りでは、4 回ぶんの再エンコードが画素に残る
    const diff = firstPageDiff(control, spun);
    expect(diff.sizes[1]).toEqual(diff.sizes[0]);
    expect(
      diff.mae,
      `1 回だけ書いた画像との画素の平均差が ${diff.mae}`,
    ).toBeLessThan(SAME_IMAGE_MAE);
  });

  test("切り抜き枠を動かすと viewer での見え方が変わる", async ({ page }) => {
    // Arrange - 左右で色が違う見開き。枠を寄せた側の色だけが残るはず
    const archive = writeSpreadArchive(sidecar.workDir, "枠と見え方.zip");
    await openCover(page, archive);
    await expect(page.getByTestId("cover-size")).toHaveText("1600×1200");
    const before = await settledPreview(page);

    // Act - 枠を右端いっぱいまで運ぶ。右半分（青）だけが枠に入る
    const start = await frameBox(page);
    await dragFrameTo(page, "right");
    expect((await frameBox(page)).x).toBeGreaterThan(start.x + 20);

    // Assert - 確定しなくても、切り抜いた結果が見える
    await expect
      .poll(() => previewShot(page), {
        timeout: 15_000,
        message: "枠を動かしても viewer での見え方が変わりません",
      })
      .not.toBe(before);
    const right = await settledPreview(page);

    // Act - 反対側へ運ぶ。今度は左半分（赤）だけが枠に入る
    await dragFrameTo(page, "left");

    // Assert - 寄せた側によって見え方が違う。どちらへ寄せても同じなら、
    // 枠の中身ではなく「動かしたこと」に反応しているだけ
    await expect
      .poll(() => previewShot(page), {
        timeout: 15_000,
        message: "枠をどちら側へ寄せても viewer での見え方が同じです",
      })
      .not.toBe(right);
    expect(await settledPreview(page)).not.toBe(before);
  });

  test("枠を戻すと、切り抜きも回転も初期状態に戻る", async ({ page }) => {
    // Arrange
    const archive = writeSpreadArchive(sidecar.workDir, "全部戻す.zip");
    await openCover(page, archive);
    await expect(page.getByTestId("cover-size")).toHaveText("1600×1200");
    const initialFrame = await frameBox(page);
    const initialShot = await settledPreview(page);

    // Act - 90 度回し、枠も動かす
    await rotateOnce(page, initialShot);
    await dragFrameTo(page, "right");

    // Act - 戻す
    await page.getByTestId("crop-reset").click();

    // Assert - 見え方が開いた直後に戻る。枠だけ戻しても回転は残ってしまう
    await expect
      .poll(() => previewShot(page), {
        timeout: 15_000,
        message: "枠を戻しても回転が残っています",
      })
      .toBe(initialShot);

    // Assert - 枠も初期状態
    const reset = await frameBox(page);
    expect(Math.abs(reset.x - initialFrame.x)).toBeLessThan(3);
    expect(Math.abs(reset.width - initialFrame.width)).toBeLessThan(3);
  });

  test("確定せずに別のファイルへ移ると、元のファイルは無傷", async ({
    page,
  }) => {
    // Arrange - 触る方と、移る先
    const first = writeSpreadArchive(sidecar.workDir, "無傷 1.zip");
    const second = writeSpreadArchive(sidecar.workDir, "無傷 2.zip");
    const before = archiveState(first);
    await openCover(page, first);
    await expect(page.getByTestId("cover-size")).toHaveText("1600×1200");

    // Act - 枠を動かし、回しもする。確定はしない
    const start = await frameBox(page);
    await dragFrameTo(page, "right");
    expect((await frameBox(page)).x).toBeGreaterThan(start.x + 20);
    await rotateOnce(page, await settledPreview(page));

    // Act - 確定しないまま別のファイルを選ぶ
    await page.getByTestId("change-archive").click();
    await expect(page.getByTestId("dropzone")).toBeVisible();
    await chooseArchiveViaBrowser(page, second);
    await expect(page.getByTestId("thumbnail-archive-name")).toHaveText(
      "無傷 2.zip",
    );

    // Assert - 触っていたファイルは 1 バイトも変わっていない
    expect(archiveState(first)).toEqual(before);
  });

  test("左右に分割する操作は無い", async ({ page }) => {
    // Arrange - 見開きを開く。分割が要りそうな場面でも置かない
    const archive = writeSpreadArchive(sidecar.workDir, "分割なし.zip");
    await openCover(page, archive);
    await expect(page.getByTestId("crop-frame")).toBeVisible();

    // Assert - 範囲を選ぶ枠と役目が重なるため、ページを割る操作はここに無い
    await expect(page.getByTestId("split-right")).toHaveCount(0);
    await expect(page.getByTestId("split-left")).toHaveCount(0);
  });

  test("90 度回してもボタンの位置が動かない", async ({ page }) => {
    // Arrange - 操作の列が縦に溢れる大きさで見る。溢れていない間は主操作が
    // 列の下端に貼り付くので、間の警告が出入りしてもずれない。実機で報告
    // されたずれは、列が溢れて下端に貼り付けなくなったときに起きる
    await page.setViewportSize({ width: 1000, height: 560 });
    const archive = writeSpreadArchive(sidecar.workDir, "ボタン位置.zip");
    await openCover(page, archive);
    await expect(page.getByTestId("cover-size")).toHaveText("1600×1200");
    await expect(page.getByTestId("spread-warning")).toBeVisible();

    const topOf = async (id: string) => {
      const box = await page.getByTestId(id).boundingBox();
      if (!box) throw new Error(`${id} が描画されていません`);
      return Math.round(box.y);
    };
    /**
     * 見え方の見本から測った、ボタンまでの距離。
     *
     * 溢れた列は押した拍子にスクロールするので、画面上の y をそのまま比べると
     * スクロールぶんまで拾ってしまう。警告は見本とボタンの間にあるので、
     * 見本からの距離で見れば、警告が場所を空けたままかどうかだけが残る。
     */
    const gaps = async () => {
      const preview = await topOf("cover-frame");
      return {
        choose: (await topOf("choose-page")) - preview,
        apply: (await topOf("apply-thumbnail")) - preview,
      };
    };
    const before = await gaps();

    // Act
    await rotateOnce(page, await settledPreview(page));

    // Assert - 見開きの警告が出入りしても、押す場所は動かない。
    // 加工の反映は後から届くので、しばらく見張って一番動いた量を見る。
    // 1 回だけ測ると、届く前の値を見て「動かなかった」と取り違える
    const worst = { choose: 0, apply: 0 };
    const until = Date.now() + BUTTON_WATCH_MS;
    while (Date.now() < until) {
      const now = await gaps();
      worst.choose = Math.max(worst.choose, Math.abs(now.choose - before.choose)); // prettier-ignore
      worst.apply = Math.max(worst.apply, Math.abs(now.apply - before.apply));
      await page.waitForTimeout(50);
    }
    expect(
      worst.apply,
      `確定ボタンが、見え方の見本から ${before.apply}px の所から ${worst.apply}px ぶん動いた`,
    ).toBeLessThanOrEqual(BUTTON_SHIFT_TOLERANCE);
    expect(
      worst.choose,
      `画像を選ぶボタンが、見え方の見本から ${before.choose}px の所から ${worst.choose}px ぶん動いた`,
    ).toBeLessThanOrEqual(BUTTON_SHIFT_TOLERANCE);
  });
});

/** 候補を格子で見るために用意するページ数。1 行には収まらない量にする */
const MANY_PAGES = 24;

/**
 * 候補一覧は、切り抜きの面と入れ替えて大きく出す。
 *
 * 単行本は 150〜200 ページある。1 行のフィルムストリップでは、中ほどの
 * ページへ辿り着けない。
 */
test.describe("サムネイル作成: 候補一覧", () => {
  test("候補一覧は切り抜きの面と入れ替わる", async ({ page }) => {
    // Arrange
    const archive = writeArchive(sidecar.workDir, "候補と入れ替え.zip", [
      { name: "page-a.jpg", color: "#ff0000" },
      { name: "page-b.jpg", color: "#00ff00" },
      { name: "page-c.jpg", color: "#0000ff" },
    ]);
    await openCover(page, archive);
    await expect(page.getByTestId("crop-frame")).toBeVisible();

    // Act - 候補を開く
    await page.getByTestId("choose-page").click();

    // Assert - 切り抜きの面は退く。同時に見比べる必要は薄い
    await expect(page.getByTestId("thumbnail-candidate")).toHaveCount(3);
    await expect(page.getByTestId("crop-frame")).toBeHidden();

    // Act - 閉じる
    await page.getByTestId("choose-page").click();

    // Assert - 切り抜きの面が戻る
    await expect(page.getByTestId("thumbnail-candidate")).toHaveCount(0);
    await expect(page.getByTestId("crop-frame")).toBeVisible();
  });

  test(`${MANY_PAGES} ページの候補が 1 行に収まらず格子に並ぶ`, async ({
    page,
  }) => {
    // Arrange - 1 行では収まらない数のページ
    const archive = writeArchive(
      sidecar.workDir,
      "候補が多い.zip",
      Array.from({ length: MANY_PAGES }, (_, index) => ({
        name: `${String(index + 1).padStart(3, "0")}.jpg`,
        color: "#3366cc",
      })),
    );
    await openCover(page, archive);

    // Act
    await page.getByTestId("choose-page").click();
    const candidates = page.getByTestId("thumbnail-candidate");
    await expect(candidates).toHaveCount(MANY_PAGES);

    // Assert - 縦に積まれている
    const boxes = await candidates.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width };
      }),
    );
    const rows = new Set(boxes.map((box) => Math.round(box.y)));
    expect(rows.size, `候補が ${rows.size} 行に並んでいる`).toBeGreaterThan(1);

    // Assert - 横へ流して隠さない。全部が候補の場所の幅に収まる
    const area = (await page.getByTestId("page-candidates").boundingBox())!;
    const spread =
      Math.max(...boxes.map((box) => box.x + box.width)) -
      Math.min(...boxes.map((box) => box.x));
    expect(
      spread,
      `候補が横へ ${Math.round(spread)}px 続き、幅 ${Math.round(area.width)}px に収まらない`,
    ).toBeLessThanOrEqual(area.width + 2);
  });
});

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
    runPython(
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
    );
    return target;
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
    const pages = pageEntriesOf(archive);
    expect(pages).toHaveLength(3);
    expect(pages).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
    expect(pageColours(archive)).toEqual(["green", "red", "blue"]);

    // Assert - 加工前の元画像と記録（#66）はページ以外として残る。
    // ページだけを見ていると、同梱そのものが失われても気づけない
    const stored = storedOriginalsOf(archive);
    expect(stored.manifest).toBeTruthy();
    expect(stored.originals).toHaveLength(1);
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
