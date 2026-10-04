import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  VIEWER_CONTRACT_IMPORT,
  pageSizesOf,
  runPython,
  storedOriginalsOf,
} from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 切り抜きを広げる方向へ戻せることを、画面の操作から確かめる（#66 画面側）。
 *
 * 一度切り抜いて確定すると、ZIP に残っているのは切り抜き後の画像だけになる。
 * それを対象に開き直す限り、範囲は縮める方向にしか動かせない。加工前の画像は
 * 同じ ZIP に同梱されているので、開き直したときはそちらを対象にする。
 *
 * 利用者から見れば「元画像」も「加工後」も無い。開いたら前回の枠が出ていて、
 * それを外側へ広げられる、というだけの話になる。
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 表紙にする 1 枚の寸法を指定して ZIP を作る。左右で色を分け、向きも見える */
function writeArchiveWithCover(
  name: string,
  width: number,
  height: number,
): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `
import io, sys, zipfile
from PIL import Image
width, height = int(sys.argv[2]), int(sys.argv[3])
cover = Image.new("RGB", (width, height), "#ff2020")
cover.paste(Image.new("RGB", (width // 2, height), "#2020ff"), (width // 2, 0))
buffer = io.BytesIO()
cover.save(buffer, "JPEG", quality=95)
page = io.BytesIO()
Image.new("RGB", (600, 900), "#888888").save(page, "JPEG")
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("001.jpg", buffer.getvalue())
    archive.writestr("002.jpg", page.getvalue())
`,
    target,
    String(width),
    String(height),
  );
  return target;
}

/** サムネイル作成の画面を開く。開き直すときも同じ入口を通る */
async function openCover(page: Page, archive: string) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=thumbnail&archive=${encodeURIComponent(archive)}`,
  );
  await expect(page.getByTestId("crop-frame")).toBeVisible();
}

/**
 * 別の機会に開き直す。まっさらな窓で開く。
 *
 * 同じ窓で開き直すと、画像は前に見たものがそのまま出る。/api/image は
 * max-age=3600 を付けて返し、URL も同じなので、ブラウザは取りに行かない。
 * 加工前の絵が画面に残ったままになり、対象が切り抜き後のままでも
 * 「元画像が表示されている」ように見えてしまう。
 *
 * 利用者が後日また開くときは、その持ち越しは無い。まっさらな窓で開けば、
 * いま実際にサイドカーから届く絵だけを見ることになる。
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

/**
 * いま画面に出ている画像そのものの寸法。
 *
 * 画面の表示（cover-size）ではなく、読み込まれた画像の naturalWidth を見る。
 * 表示だけ元画像の寸法に差し替えても、実際に届いている絵が切り抜き後のままなら
 * 枠を広げても取り戻せる画素は無い。見たいのは絵そのもの。
 */
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
 * 画面上の px は窓の大きさで変わる。表示している絵の枠との比で測れば、
 * どんな縮尺でも「画像のどこを選んでいるか」を同じ数で比べられる。
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

/** 画像の画素で測った、位置と大きさの許容差。画面上の数 px ぶんに当たる */
const FRAME_TOLERANCE = 30;

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

/** 枠の真ん中を掴んで、指定した側の端いっぱいまで運ぶ */
async function dragFrameTo(page: Page, side: "left" | "right") {
  const box = await boxOf(page, "crop-frame");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const viewport = page.viewportSize()!;
  await dragFrom(page, centre, {
    x: side === "right" ? viewport.width - 1 : 1,
    y: centre.y,
  });
}

/** 掴む所の中心 */
async function handleCentre(page: Page) {
  const handle = await boxOf(page, "crop-handle");
  return { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
}

/**
 * 掴んで内側へ運び、枠の右下が画像の fraction の所へ来るまで縮める。
 * 枠の縦横比は固定しない（#146）ので、縦横どちらも縮める
 */
async function shrinkFrameTo(page: Page, fraction: number) {
  const image = await boxOf(page, "cover-image");
  const grip = await handleCentre(page);
  await dragFrom(page, grip, {
    x: image.x + image.width * fraction,
    y: image.y + image.height * fraction,
  });
}

/** 掴んで外側へ運び、広げられるところまで広げる。窓の外まで運べば端で止まる */
async function growFrameAsFarAsPossible(page: Page) {
  const grip = await handleCentre(page);
  const viewport = page.viewportSize()!;
  await dragFrom(page, grip, {
    x: viewport.width - 1,
    y: viewport.height - 1,
  });
}

/** いまの枠で確定し、書き込みが終わるまで待つ */
async function confirmThumbnail(page: Page) {
  await page.getByTestId("apply-thumbnail").click();
  await expect(page.getByTestId("cover-status")).toContainText("加工しました", {
    timeout: 30_000,
  });
}

/** 保存されている表紙（先頭ページ）の寸法。確定の結果を中身から見る */
function coverPageSize(archive: string): [number, number] {
  const sizes = pageSizesOf(archive);
  const first = Object.keys(sizes).sort()[0];
  return sizes[first];
}

/**
 * 表紙の右端に、元画像の右半分（青）が入っているか。
 *
 * 寸法だけを見ると、狭い画像を引き伸ばしただけでも「大きくなった」ことに
 * なってしまう。元画像は左半分が赤・右半分が青なので、狭く切った赤だけの
 * 画像をいくら引き伸ばしても青は出てこない。青が出ていれば、確かに
 * 捨てたはずの画素を取り戻している。
 */
function coverReachesTheBlueHalf(archive: string): boolean {
  const output = runPython(
    `
import io, json, sys, zipfile
from PIL import Image
${VIEWER_CONTRACT_IMPORT}
with zipfile.ZipFile(sys.argv[1]) as archive:
    name = sorted(n for n in archive.namelist() if is_viewer_page(n))[0]
    with Image.open(io.BytesIO(archive.read(name))) as opened:
        image = opened.convert("RGB")
        red, _, blue = image.getpixel((image.width - 5, image.height // 2))
print(json.dumps(blue > red))
`,
    archive,
  );
  return JSON.parse(output);
}

test.describe("サムネイル作成: 切り抜きを広げる方向に戻せる", () => {
  test("一度切り抜いた本を開き直すと、元画像が表示される", async ({
    page,
    browser,
  }) => {
    // Arrange - 見開き（1600×1200）の右半分だけを表紙にして確定する
    const archive = writeArchiveWithCover("開き直すと元画像.zip", 1600, 1200);
    await openCover(page, archive);
    await expect(page.getByTestId("cover-size")).toHaveText("1600×1200");
    await dragFrameTo(page, "right");
    await confirmThumbnail(page);
    expect(coverPageSize(archive)).toEqual([800, 1200]);

    // Act - 同じ本をもう一度開く
    const reopened = await reopen(browser, archive);

    // Assert - 届いている絵は切り抜き後（800×1200）ではなく元画像（1600×1200）。
    // 切り抜き後を対象にしている限り、枠を外へ広げても取り戻す画素が無い
    expect(
      await shownImageSize(reopened),
      "開き直しても切り抜き後の画像が対象のままです",
    ).toEqual([1600, 1200]);

    // Assert - 開いただけでは保存されている表紙は変わらない
    expect(coverPageSize(archive)).toEqual([800, 1200]);
    await reopened.context().close();
  });

  test("開き直すと、前回の切り抜き範囲が枠として示される", async ({
    page,
    browser,
  }) => {
    // Arrange - 物差しとして、一度も加工していない同じ寸法の本での既定の枠を測る。
    // 既定は中央（左 400 付近）なので、右端へ寄せた範囲とは重ならない
    const fresh = writeArchiveWithCover("枠の既定.zip", 1600, 1200);
    await openCover(page, fresh);
    const initial = await frameInImagePixels(page, [1600, 1200]);
    expect(Math.abs(initial.left - 400)).toBeLessThan(FRAME_TOLERANCE);

    // Arrange - 別の本で、枠を右端いっぱい（左 800 から）へ寄せて確定する
    const archive = writeArchiveWithCover("枠を復元.zip", 1600, 1200);
    await openCover(page, archive);
    await dragFrameTo(page, "right");
    await confirmThumbnail(page);
    expect(coverPageSize(archive)).toEqual([800, 1200]);

    // Act - 開き直す
    const reopened = await reopen(browser, archive);

    // Assert - 枠は元画像の上に置かれる。ここが切り抜き後の絵だと、
    // 以降の座標の読み替えそのものが意味を持たない
    expect(await shownImageSize(reopened)).toEqual([1600, 1200]);

    // Assert - 枠が前回確定した範囲に合っている
    const restored = await frameInImagePixels(reopened, [1600, 1200]);
    expect(
      Math.abs(restored.left - 800),
      `枠の左端が元画像の ${Math.round(restored.left)}px にある（前回は 800px）`,
    ).toBeLessThan(FRAME_TOLERANCE);
    expect(Math.abs(restored.top - 0)).toBeLessThan(FRAME_TOLERANCE);
    expect(Math.abs(restored.width - 800)).toBeLessThan(FRAME_TOLERANCE);
    expect(Math.abs(restored.height - 1200)).toBeLessThan(FRAME_TOLERANCE);

    // Assert - 既定の枠と偶然一致していない。中央のままなら、前回の範囲を
    // 読んだのではなく、ただ初期状態を出しているだけ
    expect(
      Math.abs(restored.left - initial.left),
      "前回の範囲ではなく既定の枠が出ています",
    ).toBeGreaterThan(300);
    await reopened.context().close();
  });

  test("開き直した枠を、前回より広い範囲へ広げて確定できる", async ({
    page,
    browser,
  }) => {
    // Arrange - 1200×1200。開いたときの枠は画像の全体（#146）
    const archive = writeArchiveWithCover("枠を広げる.zip", 1200, 1200);
    await openCover(page, archive);
    await expect(page.getByTestId("cover-size")).toHaveText("1200×1200");

    // Arrange - 左端へ寄せてから掴んで縮め、狭い範囲で確定する。
    // 確定後の ZIP には、この狭い範囲の画像しか残らない
    await dragFrameTo(page, "left");
    await shrinkFrameTo(page, 0.3);
    await confirmThumbnail(page);
    const narrow = coverPageSize(archive);
    expect(
      narrow[0],
      `縮めたつもりの表紙が ${narrow[0]}×${narrow[1]} で、広げる余地がない`,
    ).toBeLessThan(600);
    // この時点で残っているのは左半分（赤）だけ。右半分は捨てられている
    expect(coverReachesTheBlueHalf(archive)).toBeFalsy();

    // Act - 開き直し、掴んだ所を外へ運んで広げてから確定する
    const reopened = await reopen(browser, archive);
    await dragFrameTo(reopened, "left");
    await growFrameAsFarAsPossible(reopened);
    await confirmThumbnail(reopened);

    // Assert - 出来上がった表紙が前回より大きい。ここがこの機能の目的で、
    // 枠が動くだけで結果が変わらない作りはここで落ちる
    const widened = coverPageSize(archive);
    expect(
      widened[0],
      `広げたのに表紙は ${widened[0]}×${widened[1]}（前回は ${narrow[0]}×${narrow[1]}）`,
    ).toBeGreaterThan(narrow[0] + 100);
    expect(widened[1]).toBeGreaterThan(narrow[1] + 100);

    // Assert - 一度捨てた画素が戻っている。寸法だけなら引き伸ばしでも
    // 大きくなるが、赤しか無い画像から青は出てこない
    expect(
      coverReachesTheBlueHalf(archive),
      "大きくはなったが、捨てた画素は戻っていない（引き伸ばしただけ）",
    ).toBeTruthy();

    // Assert - 枠は画像の全体（1200×1200）で止まり、足りない上下を余白で
    // 足した 2:3（1200×1800）になる（#146）
    expect(widened).toEqual([1200, 1800]);

    // Assert - 何度加工しても元画像は最初の 1 枚のまま。加工のたびに
    // 増えるなら、加工後の画像を元画像として貯め込んでいる
    expect(storedOriginalsOf(archive).originals).toHaveLength(1);
    await reopened.context().close();
  });

  test("一度も加工していない本では、従来どおり動く", async ({ page }) => {
    // Arrange - 元画像も記録も無い本
    const archive = writeArchiveWithCover("元画像なし.zip", 1200, 1200);
    expect(storedOriginalsOf(archive).manifest).toBeFalsy();
    await openCover(page, archive);

    // Assert - 対象は保存されている画像そのもの
    await expect(page.getByTestId("cover-size")).toHaveText("1200×1200");
    expect(await shownImageSize(page)).toEqual([1200, 1200]);

    // Assert - 枠は既定の、画像の全体が収まる 2:3（#141）。復元する範囲が
    // 無いのに枠が崩れない
    const frame = await frameInImagePixels(page, [1200, 1200]);
    expect(Math.abs(frame.left - 0)).toBeLessThan(FRAME_TOLERANCE);
    expect(Math.abs(frame.width - 1200)).toBeLessThan(FRAME_TOLERANCE);

    // Act - 何も触らずに確定する
    await confirmThumbnail(page);

    // Assert - 上下に余白を足した 2:3 が表紙になり、加工前の画像が同梱される
    expect(coverPageSize(archive)).toEqual([1200, 1800]);
    expect(storedOriginalsOf(archive).originals).toHaveLength(1);
  });
});
