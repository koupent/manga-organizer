import { expect, test, type Browser, type Page } from "@playwright/test";
import { coloursOf, pageEntriesOf, pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * ページ分割の画面（#58 段階 3）。
 *
 * 横長 1 枚に入った見開きを 2 ページへ割る。利用者に見せるのは「見開きが
 * 何ページ目になるか」だけで、割る前の画像と割った半分の区別は最後まで
 * 出さない。ここで検証するのは、開いた直後の判定・番号の計算・確定した
 * 中身・見開きが無いとき・古い画面からの確定。最後に、1280×860 の窓で
 * 状態が移っても配置が動かないことを測る。
 *
 * 番号はファイル名から作らない。チェックの結果から数え直す。名前から作ると、
 * 割った直後に 002.png が「2 ページ目の右半分」になり、以降の番号が
 * すべて 1 つずれる。利用者はページ番号を頼りに見開きを探すので、そのずれは
 * そのまま作業のやり直しになる。
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 見開きと判定する縦横比。manga_core.cover_editor と同じ値 */
const SPREAD_RATIO = 1.2;

/** 見開きの寸法。比 1.333 で閾値の上 */
const SPREAD = [2400, 1800];

/** 判定から漏れる横長。比 1.15 は閾値の下。ここが T1 の見分けどころ */
const NEAR_SPREAD = [1380, 1200];

/** 番号の区切り。見取り図と同じ EN DASH（U+2013） */
const RANGE = "–";

/**
 * 検証用の本を作る。ページごとに色を変え、並びと中身を色で追えるようにする。
 *
 * 見開きだけ左右で色を分ける。割った後に「先に読む方」が右半分（青）で
 * あることは、寸法では確かめられない。同じページを 2 枚に複製する実装でも
 * 枚数と寸法は合ってしまう。
 */
const ARCHIVE_SETUP = `
import io, json, sys, zipfile
from pathlib import Path
from PIL import Image

def flat(width, height, colour):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, "PNG")
    return buffer.getvalue()

def bicolour(width, height, left, right):
    image = Image.new("RGB", (width, height), left)
    half = Image.new("RGB", (width - width // 2, height), right)
    image.paste(half, (width // 2, 0))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()

def build(target, entries):
    with zipfile.ZipFile(Path(target), "w", zipfile.ZIP_DEFLATED) as archive:
        for index, entry in enumerate(entries, 1):
            name = "%03d.png" % index
            if entry["kind"] == "spread":
                data = bicolour(entry["w"], entry["h"], "#ff2020", "#2020ff")
            else:
                data = flat(entry["w"], entry["h"], entry["colour"])
            archive.writestr(name, data)
`;

/** 縦長 1 枚ぶんの指定 */
const tall = (colour: string) => ({
  kind: "flat",
  w: 1200,
  h: 1800,
  colour,
});

/**
 * 縦長・見開き・準見開きが混ざった本。
 *
 * 全ページが見開きの本では「全部にチェックを入れる」実装でも既定が合って
 * しまう。比 1.15 の 4 ページ目が、判定しているのか付けて回っているのかを
 * 分ける。
 */
function writeMixedArchive(name: string): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `${ARCHIVE_SETUP}
build(sys.argv[1], json.loads(sys.argv[2]))
`,
    target,
    JSON.stringify([
      tall("#00ff00"),
      { kind: "spread", w: SPREAD[0], h: SPREAD[1] },
      tall("#ffff00"),
      { kind: "flat", w: NEAR_SPREAD[0], h: NEAR_SPREAD[1], colour: "#ff00ff" },
      tall("#00ffff"),
    ]),
  );
  return target;
}

/** 縦長しか入っていない本。見開きが 1 枚も見つからないときの画面に使う */
function writeTallOnlyArchive(name: string): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `${ARCHIVE_SETUP}
build(sys.argv[1], json.loads(sys.argv[2]))
`,
    target,
    JSON.stringify([
      tall("#00ff00"),
      tall("#ffff00"),
      tall("#ff00ff"),
      tall("#00ffff"),
    ]),
  );
  return target;
}

/** ページ分割の画面を開き、走査が終わって格子が出るまで待つ */
async function openSplit(page: Page, archive: string, cards: number) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=split&archive=${encodeURIComponent(archive)}`,
  );
  await expect(page.getByTestId("mode-split")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("split-grid")).toBeVisible({ timeout: 30_000 });
  await expect(cardsOf(page)).toHaveCount(cards, { timeout: 30_000 });
}

/** まっさらな窓で開く。前に見た画像も保留中のチェックも持ち越さない */
async function openIn(
  browser: Browser,
  archive: string,
  cards: number,
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openSplit(page, archive, cards);
  return page;
}

function cardsOf(page: Page) {
  return page.locator('[data-testid="split-card"]');
}

function cardAt(page: Page, index: number) {
  return page.locator(`[data-testid="split-card"][data-index="${index}"]`);
}

/**
 * チェックが入っているカードの位置。集合そのものを見る。
 *
 * 「何枚に入っているか」だけを見ると、全部に付けて回る実装でも枚数が
 * 合ってしまう。どのページに付いているかまで見る。
 */
async function checkedIndexes(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="split-card"]')]
      .filter((card) => card.dataset.checked === "true")
      .map((card) => Number(card.dataset.index)),
  );
}

/** 2 列ぶんを占めているカードの位置。見開きは形で目に留まる */
async function wideIndexes(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="split-card"]')]
      .filter((card) => card.dataset.wide === "true")
      .map((card) => Number(card.dataset.index)),
  );
}

/** 画面に出ている番号を、並んでいる順に読む */
async function chipsOf(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>('[data-testid="split-card"]'),
    ].map(
      (card) =>
        card
          .querySelector<HTMLElement>('[data-testid="split-number"]')
          ?.textContent?.trim() ?? "",
    ),
  );
}

/** 1 枚のチェックを切り替える */
async function toggle(page: Page, index: number) {
  await cardAt(page, index).getByTestId("split-check").click();
}

async function boxOf(page: Page, locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("要素が描画されていません");
  return box;
}

/**
 * 分割線を、表示している画像の幅の割合まで運ぶ。
 *
 * 画面上の px は窓の大きさと表示サイズで変わる。割合で運べば、どんな縮尺でも
 * 「画像のどこを指したか」を同じ数で比べられる。
 */
async function dragSplitTo(page: Page, index: number, fraction: number) {
  const card = cardAt(page, index);
  const image = await boxOf(page, card.getByTestId("split-image"));
  const handle = await boxOf(page, card.getByTestId("split-handle"));
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(image.x + image.width * fraction, y, { steps: 12 });
  await page.mouse.up();
}

/** いま画面が指している分割位置（元画像の画素で読む） */
async function splitValue(page: Page, index: number): Promise<number> {
  const value = await cardAt(page, index)
    .getByTestId("split-handle")
    .getAttribute("aria-valuenow");
  return Number(value);
}

/** いまの内容で確定し、書き込みが終わるまで待つ */
async function confirmSplit(page: Page) {
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-status")).toHaveAttribute(
    "data-state",
    "done",
    { timeout: 30_000 },
  );
}

test.describe("ページ分割: 開いた直後と確定", () => {
  test("既定のチェックは判定の結果で、横長でも閾値の下には付かない", async ({
    page,
  }) => {
    // Arrange - 縦長・比 1.333 の見開き・比 1.15 の横長が混ざった本
    const archive = writeMixedArchive("判定.zip");
    expect(
      NEAR_SPREAD[0] / NEAR_SPREAD[1],
      "準見開きが閾値を超えていて、見分けどころにならない",
    ).toBeLessThan(SPREAD_RATIO);
    expect(SPREAD[0] / SPREAD[1]).toBeGreaterThanOrEqual(SPREAD_RATIO);

    // Act - 開く
    await openSplit(page, archive, 5);

    // Assert - タブは末尾に足す。使う順に並べているので、割るのは最後
    expect(
      await page.locator('[data-testid^="mode-"]').allTextContents(),
    ).toEqual([
      "ファイル整理",
      "サムネイル作成",
      "ページ並べ替え",
      "ページ分割",
    ]);

    // Assert - チェックが入るのは 2 枚目だけ。全部に付けて回る実装は、
    // 4 枚目（比 1.15）に付くことでここで落ちる。利用者から見れば、
    // 割ってはいけない縦長ページが黙って 2 ページに割られるということ
    expect(
      await checkedIndexes(page),
      "チェックが入っているページが判定と違う",
    ).toEqual([1]);

    // Assert - 2 列ぶんを占めるのも横長の 1 枚だけ。準見開きは列をまたがない
    expect(await wideIndexes(page)).toEqual([1]);

    // Assert - 見出しの数え方と、押したら何が起きるかの文
    await expect(page.getByTestId("split-detected-count")).toHaveText(
      "見開き 1 枚",
    );
    await expect(page.getByTestId("split-page-count")).toHaveText("5 ページ");
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 枚を 2 ページに分けます（全 6 ページになります）",
    );
  });

  test("番号はチェックの結果から数え直し、後ろのページまで繰り上がる", async ({
    page,
  }) => {
    // Arrange
    const archive = writeMixedArchive("番号.zip");
    await openSplit(page, archive, 5);

    // Assert - 2 枚目が 2 ページ分になり、3 枚目以降が繰り下がっている
    expect(await chipsOf(page)).toEqual(["1", `2${RANGE}3`, "4", "5", "6"]);

    // Act - 誤判定を直すつもりで、2 枚目のチェックを外す
    await toggle(page, 1);

    // Assert - 外した行だけでなく、その後ろが全部 1 つずつ戻る。
    // 外した行の番号しか見ない検証は、ファイル名から番号を作る実装でも通る
    expect(
      await chipsOf(page),
      "チェックを外したのに後ろのページの番号が動いていない",
    ).toEqual(["1", "2", "3", "4", "5"]);

    // Act - 見逃しを直すつもりで、4 枚目（比 1.15）に手でチェックを入れる
    await toggle(page, 3);

    // Assert - 判定に漏れた行でも、入れれば同じように番号が動く
    expect(await chipsOf(page)).toEqual(["1", "2", "3", `4${RANGE}5`, "6"]);
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 枚を 2 ページに分けます（全 6 ページになります）",
    );
  });

  test("線を動かして確定すると、その位置で切れた 2 ページになる", async ({
    page,
  }) => {
    // Arrange
    const archive = writeMixedArchive("確定.zip");
    await openSplit(page, archive, 5);
    expect(pageEntriesOf(archive)).toHaveLength(5);

    // Act - 中央（1200）から右へずらす。中央のままだと、位置を読まずに
    // 真ん中で割る実装でも同じ結果になる
    await dragSplitTo(page, 1, 0.55);
    const x = await splitValue(page, 1);
    expect(
      Math.abs(x - SPREAD[0] * 0.55),
      `線が ${x}px にある。運んだ先と読み取りが対応していない`,
    ).toBeLessThan(60);
    expect(Math.abs(x - SPREAD[0] / 2)).toBeGreaterThan(40);

    // Act
    await confirmSplit(page);

    // Assert - ページが 1 枚だけ増えた
    const entries = pageEntriesOf(archive);
    expect(entries).toHaveLength(6);

    // Assert - 先のページが右半分（青）、次が左半分（赤）。枚数だけを見ると、
    // 同じページを 2 枚に複製する実装でも通ってしまう。切れた証拠は色にしかない
    const painted = coloursOf(archive);
    const colours = entries.map((name) => painted[name]);
    expect(colours, "割った 2 枚の中身が右半分・左半分になっていない").toEqual([
      "#00ff00",
      "#2020ff",
      "#ff2020",
      "#ffff00",
      "#ff00ff",
      "#00ffff",
    ]);

    // Assert - 切れた場所が画面の指していた位置そのもの。右綴じなので
    // 先に読む方が右半分（幅は 2400 - x）になる
    const sizes = pageSizesOf(archive);
    expect(sizes[entries[1]]).toEqual([SPREAD[0] - x, SPREAD[1]]);
    expect(sizes[entries[2]]).toEqual([x, SPREAD[1]]);
  });

  test("見開きが 1 枚も無くても一覧は出て、手でチェックを入れられる", async ({
    page,
  }) => {
    // Arrange - 縦長しか入っていない本
    const archive = writeTallOnlyArchive("見開きなし.zip");

    // Act
    await openSplit(page, archive, 4);

    // Assert - 空の画面にはしない。判定は外れうるので、一覧は出したまま
    // 見つからなかったことを言う。ここを Empty にすると、判定から漏れた
    // 見開きを利用者が手で直す道が無くなる
    await expect(page.getByTestId("split-status")).toHaveText(
      "見開きは見つかりませんでした",
    );
    expect(await checkedIndexes(page)).toEqual([]);
    await expect(page.getByTestId("split-confirm")).toBeDisabled();

    // Act - 見逃された見開きのつもりで、3 枚目に手でチェックを入れる
    await toggle(page, 2);

    // Assert - 入る。文言だけを見る検証は、一覧を出さない実装でも通る
    expect(await checkedIndexes(page)).toEqual([2]);
    expect(await chipsOf(page)).toEqual(["1", "2", `3${RANGE}4`, "5"]);
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 枚を 2 ページに分けます（全 5 ページになります）",
    );
    await expect(page.getByTestId("split-confirm")).toBeEnabled();
  });

  test("先に別の窓で割られていたら、確定は断られたと分かる形で止まる", async ({
    browser,
  }) => {
    // Arrange - 同じ本を 2 つの窓で開く。どちらも走査した時点の印を持つ
    const archive = writeMixedArchive("競合.zip");
    const first = await openIn(browser, archive, 5);
    const second = await openIn(browser, archive, 5);

    // Act - 先の窓で確定する。ここで本は書き直され、後の窓が持つ印は古くなる
    await confirmSplit(first);
    expect(pageEntriesOf(archive)).toHaveLength(6);

    // Act - 後の窓は、いま画面に出ている（もう存在しない）行で確定しようとする
    await second.getByTestId("split-confirm").click();

    // Assert - 断られたことが画面に出る。黙って握り潰すと、利用者は割れた
    // つもりで次の巻へ移り、実際には自分の指した位置では割られていない
    const status = second.getByTestId("split-status");
    await expect(status).toHaveAttribute("data-state", "error", {
      timeout: 30_000,
    });
    await expect(status).toContainText("アーカイブが変わっています");
    await expect(status).not.toContainText("分割しました");

    // Assert - 二度目は 1 バイトも書かれていない。通っていれば、
    // 先の窓が割った右半分がさらに割られてページが増える
    expect(
      pageEntriesOf(archive),
      "断ったはずの確定が本を書き換えている",
    ).toHaveLength(6);

    await first.context().close();
    await second.context().close();
  });
});

/** 承認された受け入れ基準が書かれている窓の寸法 */
const VIEWPORT = { width: 1280, height: 860 };

/** 縦スクロールと縁の判定に許す端数。小数の丸めで 1px 動くことがある */
const SLACK = 1;

/** 文書が窓の外へ続いているか */
async function documentOverflow(page: Page) {
  return page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
}

async function expectNoWindowScroll(page: Page, when: string) {
  const overflow = await documentOverflow(page);
  expect(
    overflow.scrollHeight,
    `${when}に文書の高さが ${overflow.scrollHeight}px（窓は ${overflow.innerHeight}px）`,
  ).toBeLessThanOrEqual(overflow.innerHeight + SLACK);
}

/** 格子の上下の縁。中でスクロールするのは格子であって窓ではない */
async function gridEdges(page: Page) {
  const box = await boxOf(page, page.getByTestId("split-grid"));
  return { top: box.y, bottom: box.y + box.height };
}

test.describe("ページ分割: 配置", () => {
  test("状態が変わっても、窓は縦に伸びず格子の縁も動かない", async ({
    page,
  }) => {
    // Arrange - 走査の投入を遅らせ、読み込み中の画面を取り逃がさないようにする。
    // 応答は本物のまま。作り物を返すと、測っているのが実際の画面でなくなる
    const archive = writeMixedArchive("配置.zip");
    await page.route(/\/api\/jobs\/split-scan(\?|$)/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await page.setViewportSize(VIEWPORT);
    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&mode=split&archive=${encodeURIComponent(archive)}`,
    );

    // Assert - 読み込み中。ここで窓が伸びると、待っている間だけ画面が
    // 縦に動く
    await expect(page.getByTestId("split-loading")).toBeVisible();
    const loading = await boxOf(page, page.getByTestId("split-loading"));
    await expectNoWindowScroll(page, "読み込み中");

    // Assert - 読み込みが終わった直後。開いた時点で既に「1 枚を 2 ページに
    // 分けます（全 6 ページになります）」という長い文が出ている
    await expect(page.getByTestId("split-grid")).toBeVisible({
      timeout: 30_000,
    });
    await expect(cardsOf(page)).toHaveCount(5, { timeout: 30_000 });
    await page.unroute(/\/api\/jobs\/split-scan(\?|$)/);
    const loaded = await gridEdges(page);
    await expectNoWindowScroll(page, "読み込み後");

    // Assert - 読み込み中に使っていた面の下端と、格子の下端が同じ。
    // 待っている間と待ち終えた後で、作業面の取り分が変わらない
    expect(
      Math.abs(loading.y + loading.height - loaded.bottom),
      "読み込み中と読み込み後で、作業面の下端がずれる",
    ).toBeLessThanOrEqual(SLACK);

    // Act - チェックを外す。状態欄の文が入れ替わる
    await toggle(page, 1);
    await expect(page.getByTestId("split-status")).toHaveText(
      "変更はありません",
    );

    // Assert - 文が変わっても格子は動かない。見出しの行が折り返すと、
    // 格子が下へ押されて、いま見ていたページが視界から外れる
    const pending = await gridEdges(page);
    expect(Math.abs(pending.top - loaded.top)).toBeLessThanOrEqual(SLACK);
    expect(Math.abs(pending.bottom - loaded.bottom)).toBeLessThanOrEqual(SLACK);
    await expectNoWindowScroll(page, "保留中");

    // Act - 元に戻してから確定する
    await toggle(page, 1);
    await confirmSplit(page);

    // Assert - 書き込んだ後の文（枚数とページ数）でも縁は同じ。
    // 読み直した後も行は 5 つ。割った対は 1 行に畳まれて戻ってくる
    await expect(cardsOf(page)).toHaveCount(5, { timeout: 30_000 });
    const saved = await gridEdges(page);
    expect(Math.abs(saved.top - loaded.top)).toBeLessThanOrEqual(SLACK);
    expect(Math.abs(saved.bottom - loaded.bottom)).toBeLessThanOrEqual(SLACK);
    await expectNoWindowScroll(page, "確定後");
  });
});
