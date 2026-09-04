import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * ワークベンチ型のレイアウト。
 *
 * 第 1 段階（トークンと部品）で箱代は落ちたが、画面の骨格は縦に積んだ
 * カードのままで、対象（処理対象の一覧・表紙の画像）は決め打ちの高さに
 * 閉じ込められている。第 2・第 3 段階は「設定は固定幅の列に置き、対象が
 * 残りの領域をすべて使う」へ組み替える。
 *
 * ここで測るのは、その組み替えでしか動かない数値だけにする。
 * 見た目の好みや実装の内訳ではなく、作業面がどれだけ対象に渡ったかを見る。
 */

/** 実際に使う窓の大きさ。承認された受け入れ基準がこの寸法で書かれている */
const VIEWPORT = { width: 1280, height: 860 };

/** 縦スクロールの判定に許す端数。小数の丸めで 1px 増えることがある */
const SCROLL_SLACK = 1;

/** 処理対象の一覧に渡す作業面の下限。ビューポート高に対する割合 */
const LIST_MIN_RATIO = 0.6;

/** 行の中で、ファイル名とパスの文字が離れてよい上限 */
const NAME_PATH_MAX_GAP = 200;

/** パスらしいと判断する文字数の下限。行番号のような短い文字を拾わないため */
const MIN_PATH_TEXT = 4;

/** 600x900 の原稿を出す高さの下限。現状は max-h-96（384px）で頭打ち */
const COVER_MIN_HEIGHT = 700;

/** 候補一覧を開いている間の下限。フィルムストリップのぶんだけ緩める */
const COVER_MIN_HEIGHT_WHILE_CHOOSING = 600;

/** 候補一覧の開閉で画像がずれてよい量 */
const COVER_SHIFT_TOLERANCE = 8;

/** 一覧を高さいっぱいに広げたときに測る件数 */
const MANY = 8;

/** 行の中身や点線の枠を見るときの件数 */
const FEW = 3;

/** 処理対象を置く場所。パスの表示を探す手がかりにも使う */
const ARCHIVE_DIR = "未整理";

/** 表紙の検証に使う ZIP。どのページも 600x900 */
const COVER_ARCHIVE = "表紙候補.zip";

let sidecar: Sidecar;
let archiveNames: string[];

test.beforeAll(async () => {
  sidecar = await startSidecar();
  mkdirSync(join(sidecar.workDir, ARCHIVE_DIR), { recursive: true });
  archiveNames = Array.from(
    { length: MANY },
    (_, index) => `作品名 第${String(index + 1).padStart(2, "0")}巻.zip`,
  );
  for (const name of archiveNames) {
    writeArchive(sidecar.workDir, `${ARCHIVE_DIR}/${name}`, [
      { name: "001.jpg", color: "#ff0000" },
    ]);
  }
  writeArchive(sidecar.workDir, COVER_ARCHIVE, [
    { name: "001.jpg", color: "#ff0000" },
    { name: "002.jpg", color: "#00ff00" },
    { name: "003.jpg", color: "#0000ff" },
  ]);
});

test.afterAll(() => sidecar?.stop());

/** ファイル整理を開く。出力先は先に決めておき、未入力の警告を出さない */
async function openOrganize(page: Page, outputName: string) {
  const output = join(sidecar.workDir, outputName);
  mkdirSync(output, { recursive: true });
  await page.setViewportSize(VIEWPORT);
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("confirm")).toBeVisible();
}

/** ファイルブラウザで処理対象の置き場所まで辿る。実パスはサーバー側が返す */
async function enterArchiveDirectory(page: Page) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  await page
    .locator(
      `[data-testid="browse-entry"][data-name="${ARCHIVE_DIR}"] .browser-name`,
    )
    .click();
}

/** ブラウザを閉じ、一覧が指定の件数になったことまで確かめる */
async function closeBrowser(page: Page, count: number) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeHidden();
  await expect(page.getByTestId("selected-item")).toHaveCount(count);
}

/** 置き場所ごとまとめて処理対象にする */
async function addAll(page: Page) {
  await enterArchiveDirectory(page);
  await page.getByTestId("add-all-here").click();
  await expect(page.getByTestId("selected-count")).toHaveText(`${MANY} 件`);
  await closeBrowser(page, MANY);
}

/** 名前を指定して処理対象にする */
async function addSome(page: Page, names: string[]) {
  await enterArchiveDirectory(page);
  for (const name of names) {
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${name}"] .browser-name`,
      )
      .click();
  }
  await expect(page.getByTestId("selected-count")).toHaveText(
    `${names.length} 件`,
  );
  await closeBrowser(page, names.length);
}

/** 文書が縦に溢れているか。窓の外へ続く内容があれば縦スクロールが出る */
async function documentOverflow(page: Page) {
  return page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    bodyScrollHeight: document.body.scrollHeight,
    innerHeight: window.innerHeight,
  }));
}

/** 主操作が窓の中に見えているか。文書座標で見て、スクロール位置に騙されない */
async function primaryActionPlace(page: Page) {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="confirm"]',
    );
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
    };
  });
}

/**
 * 処理対象の一覧に渡っている領域を測る。
 *
 * 一覧をまとめている要素には testid が無く、クラス名は今回書き換わる所なので、
 * 位置関係で辿る。行をすべて含む一番内側の要素から上へ辿り、最初に見つかった
 * スクロールする箱を「一覧の領域」とする。行が収まりきらないときに中で
 * スクロールするのはその箱なので、利用者が一覧として見ている面と一致する。
 *
 * 主操作を含む所まで上ったら行き過ぎ。画面全体を一覧と言い張れないようにする。
 */
async function listRegion(page: Page) {
  return page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="selected-item"]',
      ),
    ];
    if (rows.length === 0) return null;

    let list: HTMLElement = rows[0];
    while (list.parentElement && !rows.every((row) => list.contains(row))) {
      list = list.parentElement;
    }

    const confirm = document.querySelector<HTMLElement>(
      '[data-testid="confirm"]',
    );
    let region: HTMLElement = list;
    for (
      let node: HTMLElement | null = list;
      node && node !== document.body;
      node = node.parentElement
    ) {
      if (confirm && node.contains(confirm)) break;
      if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) {
        region = node;
        break;
      }
    }

    const rect = region.getBoundingClientRect();
    return {
      height: rect.height,
      innerHeight: window.innerHeight,
      rows: rows.length,
      holdsRows: rows.every((row) => region.contains(row)),
      holdsPrimary: !!confirm && region.contains(confirm),
    };
  });
}

/**
 * 点線の枠を探す。
 *
 * 実装の中身ではなく、見えている結果だけで判断する。幅 0 の枠は何も描かない
 * ので数えない。
 */
async function dashedFrames(page: Page) {
  return page.evaluate(() => {
    const sides = ["Top", "Right", "Bottom", "Left"] as const;
    return [...document.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity) > 0
        );
      })
      .filter((element) => {
        const style = getComputedStyle(element);
        return sides.some(
          (side) =>
            style[`border${side}Style`] === "dashed" &&
            parseFloat(style[`border${side}Width`]) > 0,
        );
      })
      .map(
        (element) =>
          element.dataset.testid ||
          `${element.tagName.toLowerCase()}:${(element.textContent ?? "").trim().slice(0, 16)}`,
      );
  });
}

/**
 * 行の中で、ファイル名の文字とパスの文字がどれだけ離れているかを測る。
 *
 * 箱ではなく文字が置かれている範囲（インク）を測る。今の実装はパスの箱が
 * 行幅いっぱいに広がっていて、箱の左端はファイル名のすぐ隣にある。箱で
 * 測ると 8px となり、右端に飛んでいる文字を見逃す。
 */
async function nameAndPathGaps(page: Page, minPathText: number) {
  return page.evaluate((minText) => {
    const inkOf = (node: Text, start: number, end: number) => {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const ink = range.getBoundingClientRect();
      const box = (node.parentElement as HTMLElement).getBoundingClientRect();
      // はみ出した文字は箱で刈り取られる。見えている範囲だけを測る
      return {
        left: Math.max(ink.left, box.left),
        right: Math.min(ink.right, box.right),
      };
    };

    const strip = (text: string) => text.replace(/…|\.\.\./gu, "").trim();

    return [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="selected-item"]',
      ),
    ].map((row) => {
      const path = row.dataset.path ?? "";
      const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      const name = path.slice(cut + 1);
      const directory = path.slice(0, cut);
      const tail = directory.split(/[/\\]/).filter(Boolean).pop() ?? "";

      const texts: Text[] = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? "").trim()) texts.push(node as Text);
      }

      const found = (
        node: Text,
        start: number,
        length: number,
      ): { node: Text; start: number; end: number } => ({
        node,
        start,
        end: start + length,
      });

      // ファイル名。省略されていても、名前そのものが載っている所を探す
      let nameHit: { node: Text; start: number; end: number } | null = null;
      for (const node of texts) {
        const at = node.data.indexOf(name);
        if (at >= 0) {
          nameHit = found(node, at, name.length);
          break;
        }
      }

      // 場所。省略記号を外した中身がディレクトリの一部であれば、それがパス。
      // 一番長く一致したものを採り、行番号のような短い数字を拾わない
      let pathHit: { node: Text; start: number; end: number } | null = null;
      for (const node of texts) {
        const shown = strip(node.data);
        if (shown.length < minText || !directory.includes(shown)) continue;
        const at = node.data.indexOf(shown);
        if (!pathHit || shown.length > pathHit.end - pathHit.start) {
          pathHit = found(node, at, shown.length);
        }
      }
      // ファイル名と同じ箱に入っている、あるいは途中が省略されている場合の受け皿
      if (!pathHit && tail.length >= minText) {
        for (const node of texts) {
          const at = node.data.indexOf(tail);
          if (at >= 0) {
            pathHit = found(node, at, tail.length);
            break;
          }
        }
      }

      if (!nameHit || !pathHit) {
        return { path, nameFound: !!nameHit, pathFound: !!pathHit, gap: null };
      }

      const nameInk = inkOf(nameHit.node, nameHit.start, nameHit.end);
      const pathInk = inkOf(pathHit.node, pathHit.start, pathHit.end);
      // 左右どちらに並んでいても、2 つの文字の間に空いた距離を返す
      const gap = Math.max(
        0,
        Math.max(nameInk.left, pathInk.left) -
          Math.min(nameInk.right, pathInk.right),
      );
      return {
        path,
        nameFound: true,
        pathFound: true,
        gap,
        nameRight: nameInk.right,
        pathLeft: pathInk.left,
      };
    });
  }, minPathText);
}

/** サムネイル作成を開く */
async function openThumbnail(page: Page, archive: string) {
  await page.setViewportSize(VIEWPORT);
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=thumbnail&archive=${encodeURIComponent(archive)}`,
  );
  await expect(page.getByTestId("cover-size")).toHaveText("600×900");
  await settleImages(page);
}

/** 画像の読み込みで後からレイアウトが動くのを待つ */
async function settleImages(page: Page) {
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
}

/** 表紙の画像の大きさと、文書の中での上端 */
async function coverPlace(page: Page) {
  const place = await page.evaluate(() => {
    const image = document.querySelector<HTMLElement>(
      '[data-testid="cover-image"]',
    );
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    return {
      height: rect.height,
      width: rect.width,
      // 文書座標で見る。窓がスクロールしただけの見かけの移動と区別する
      top: rect.top + window.scrollY,
    };
  });
  expect(place, "cover-image が描画されていない").not.toBeNull();
  return place!;
}

test.describe("ワークベンチ: ファイル整理", () => {
  test("処理対象が 0 件でも縦スクロールが出ない", async ({ page }) => {
    // Arrange - 何も入れていない、開いた直後の状態
    await openOrganize(page, "out-empty");
    await expect(page.getByTestId("selected-count")).toHaveText("0 件");

    // Act
    const overflow = await documentOverflow(page);

    // Assert - 窓の外へ続く内容が無い
    expect(overflow.innerHeight).toBe(VIEWPORT.height);
    expect(
      overflow.scrollHeight,
      `文書の高さが ${overflow.scrollHeight}px（窓は ${overflow.innerHeight}px）`,
    ).toBeLessThanOrEqual(overflow.innerHeight + SCROLL_SLACK);
  });

  test(`処理対象が ${MANY} 件でも縦スクロールが出ない`, async ({ page }) => {
    // Arrange - 一覧が作業面いっぱいまで伸びた後も溢れないことを見る。
    // 一覧の中でスクロールするのは構わないので、見るのは文書の高さだけ
    await openOrganize(page, "out-many");
    await addAll(page);

    // Act
    const overflow = await documentOverflow(page);

    // Assert
    expect(overflow.innerHeight).toBe(VIEWPORT.height);
    expect(
      overflow.scrollHeight,
      `文書の高さが ${overflow.scrollHeight}px（窓は ${overflow.innerHeight}px）`,
    ).toBeLessThanOrEqual(overflow.innerHeight + SCROLL_SLACK);
    expect(overflow.bodyScrollHeight).toBeLessThanOrEqual(
      overflow.innerHeight + SCROLL_SLACK,
    );
  });

  test(`処理対象の一覧が窓の高さの ${LIST_MIN_RATIO * 100}% 以上を占める`, async ({
    page,
  }) => {
    // Arrange
    await openOrganize(page, "out-ratio");
    await addAll(page);

    // Act
    const region = await listRegion(page);

    // Assert - 測る対象が見つからないまま通らないようにする
    expect(region, "一覧の領域が見つからない").not.toBeNull();
    expect(region!.rows).toBe(MANY);
    expect(region!.holdsRows, "測った領域が行を含んでいない").toBe(true);
    expect(region!.holdsPrimary, "画面全体を一覧として測っている").toBe(false);

    // Assert - 設定ではなく対象が作業面を持つ
    const ratio = region!.height / region!.innerHeight;
    expect(
      ratio,
      `一覧の高さが ${Math.round(region!.height)}px（窓の ${Math.round(ratio * 100)}%）`,
    ).toBeGreaterThanOrEqual(LIST_MIN_RATIO);
  });

  test("主操作がスクロールせずに見える", async ({ page }) => {
    // Arrange
    await openOrganize(page, "out-primary");
    await addAll(page);

    // Act & Assert - 一覧が伸びても主操作は窓の中に残る
    const listed = await primaryActionPlace(page);
    expect(listed, "confirm が描画されていない").not.toBeNull();
    expect(listed!.scrollY, "窓がスクロールしている").toBe(0);
    expect(
      listed!.top,
      `主操作の上端が ${Math.round(listed!.top)}px`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      listed!.bottom,
      `主操作の下端が ${Math.round(listed!.bottom)}px（窓は ${listed!.innerHeight}px）`,
    ).toBeLessThanOrEqual(listed!.innerHeight);

    // Act & Assert - 主操作は設定の列にあり、右側で何が起きても動かない。
    // 「ファイルを選ぶ」を開いても押しに行ける
    await page.getByTestId("open-browser").click();
    await expect(page.getByTestId("file-browser")).toBeVisible();
    const browsing = await primaryActionPlace(page);
    expect(browsing, "confirm が描画されていない").not.toBeNull();
    expect(browsing!.scrollY, "窓がスクロールしている").toBe(0);
    expect(
      browsing!.bottom,
      `ファイルを選ぶを開くと主操作の下端が ${Math.round(browsing!.bottom)}px（窓は ${browsing!.innerHeight}px）`,
    ).toBeLessThanOrEqual(browsing!.innerHeight);
  });

  test("一覧の行でファイル名とパスが隣り合う", async ({ page }) => {
    // Arrange
    await openOrganize(page, "out-row");
    await addSome(page, archiveNames.slice(0, FEW));

    // Act
    const rows = await nameAndPathGaps(page, MIN_PATH_TEXT);

    // Assert - 1 行も測らないまま、あるいは片方を見つけられないまま通らない
    expect(rows).toHaveLength(FEW);
    for (const row of rows) {
      expect(row.nameFound, `ファイル名の文字が見つからない: ${row.path}`).toBe(
        true,
      );
      expect(row.pathFound, `パスの文字が見つからない: ${row.path}`).toBe(true);
    }

    // Assert - 名前と場所は一組の情報。行の両端に離して置かない
    for (const row of rows) {
      expect(
        row.gap,
        `ファイル名の右端 ${Math.round(row.nameRight ?? 0)}px と` +
          `パスの左端 ${Math.round(row.pathLeft ?? 0)}px が` +
          `${Math.round(row.gap ?? 0)}px 離れている`,
      ).toBeLessThanOrEqual(NAME_PATH_MAX_GAP);
    }
  });

  test("点線の枠は処理対象が空のときだけ出る", async ({ page }) => {
    // Arrange - まず空の状態。ここに落とせると分かる案内は要る
    await openOrganize(page, "out-dashed");
    await expect(page.getByTestId("selected-count")).toHaveText("0 件");

    // Act & Assert - 空なら点線が出る
    const whenEmpty = await dashedFrames(page);
    expect(
      whenEmpty.length,
      "空のときに点線の枠が出ていない",
    ).toBeGreaterThanOrEqual(1);

    // Act - 処理対象を入れる
    await addSome(page, archiveNames.slice(0, FEW));

    // Assert - 中身があるなら枠は用済み。一覧を囲い続けない
    const whenFilled = await dashedFrames(page);
    expect(
      whenFilled,
      `処理対象が ${FEW} 件あるのに点線の枠が出ている: ${JSON.stringify(whenFilled)}`,
    ).toEqual([]);
  });

  test("ファイルを選ぶと処理対象の一覧が入れ替わる", async ({ page }) => {
    // Arrange - 入れ替わりが見えるよう、一覧に中身がある状態から始める
    await openOrganize(page, "out-swap");
    await addSome(page, archiveNames.slice(0, FEW));
    const rows = page.getByTestId("selected-item");
    await expect(rows.first()).toBeVisible();

    // Act - ファイルを選ぶ
    await page.getByTestId("open-browser").click();

    // Assert - 同じ場所を使うので、一覧は退く
    await expect(page.getByTestId("file-browser")).toBeVisible();
    await expect(rows.first(), "ファイルを選ぶ間も一覧が出たまま").toBeHidden();

    // Act - 閉じる
    await page.getByTestId("open-browser").click();

    // Assert - 一覧が戻る。件数も保たれている
    await expect(page.getByTestId("file-browser")).toBeHidden();
    await expect(rows).toHaveCount(FEW);
    await expect(rows.first()).toBeVisible();
  });
});

test.describe("ワークベンチ: サムネイル作成", () => {
  test(`600x900 の原稿が ${COVER_MIN_HEIGHT}px 以上で出る`, async ({
    page,
  }) => {
    // Arrange
    await openThumbnail(page, join(sidecar.workDir, COVER_ARCHIVE));

    // Act
    const cover = await coverPlace(page);

    // Assert - 判断の材料は絵そのもの。作業面を絵に渡す
    expect(
      cover.height,
      `表紙の表示高が ${Math.round(cover.height)}px`,
    ).toBeGreaterThanOrEqual(COVER_MIN_HEIGHT);
    // 縦横比のまま伸びていること。引き伸ばして高さだけ稼がない
    expect(Math.abs(cover.width / cover.height - 600 / 900)).toBeLessThan(0.02);
  });

  test("候補一覧を開いても表紙が押し下げられない", async ({ page }) => {
    // Arrange
    await openThumbnail(page, join(sidecar.workDir, COVER_ARCHIVE));
    const before = await coverPlace(page);

    // Act - 候補一覧を開く
    await page.getByTestId("choose-page").click();
    await expect(page.getByTestId("thumbnail-candidate")).toHaveCount(3);
    await settleImages(page);

    // Assert - 候補は絵の上に割り込まない。見ている絵の位置が変わらない
    const after = await coverPlace(page);
    expect(
      Math.abs(after.top - before.top),
      `表紙の上端が ${Math.round(before.top)}px から ${Math.round(after.top)}px へ動いた`,
    ).toBeLessThanOrEqual(COVER_SHIFT_TOLERANCE);
  });

  test(`候補一覧を開いても表紙が ${COVER_MIN_HEIGHT_WHILE_CHOOSING}px 以上を保つ`, async ({
    page,
  }) => {
    // Arrange
    await openThumbnail(page, join(sidecar.workDir, COVER_ARCHIVE));

    // Act
    await page.getByTestId("choose-page").click();
    await expect(page.getByTestId("thumbnail-candidate")).toHaveCount(3);
    await settleImages(page);

    // Assert - 候補を見比べている間も、選ぶ判断は絵の大きさが要る
    const cover = await coverPlace(page);
    expect(
      cover.height,
      `候補一覧を開いた表紙の表示高が ${Math.round(cover.height)}px`,
    ).toBeGreaterThanOrEqual(COVER_MIN_HEIGHT_WHILE_CHOOSING);
  });
});
