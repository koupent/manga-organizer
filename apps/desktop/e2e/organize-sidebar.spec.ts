import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * ファイル整理: 投入は左の列、出来上がりは右の一覧（サイドバー案 段階 2A）。
 *
 * 右の 1 枚の面を「投入したもの」と「出来上がる本」が奪い合い、利用者には
 * 混ざって見えていた（#117 の発端）。投入を左の列へ移し、右は出来上がる本
 * だけにする。左の列は 作品情報（固定）/ 投入したもの（伸縮）/ オプション
 * （固定）の 3 段で、列そのものはスクロールしない。
 *
 * 正本は .sandbox/organize-sidebar-mockup.html（寸法と文言）。
 */

/** 承認された受け入れ基準がこの寸法で書かれている */
const VIEWPORT = { width: 1280, height: 860 };

/** 窓を縮めたときの高さ。モックアップの実測で投入の箱が 479 → 319 になる */
const SHORT_HEIGHT = 700;

/** 小数の丸めで 1px ずれることがある */
const SLACK = 1;

/** 窓の高さを変えたとき、投入の箱がこれ以上は伸び縮みしていること */
const BOX_MIN_DELTA = 100;

/** 左右の箱がそれぞれ持つべき高さの下限。窓の高さに対する割合 */
const BOX_MIN_RATIO = 0.4;

/** 押せる見た目とみなす不透明度の下限（祖先まで掛け合わせた実効値） */
const MIN_OPACITY = 0.4;

/** 列が溢れるかを見るときの件数。箱の高さ ÷ 行の高さより明らかに多くする */
const MANY = 24;

const ARCHIVE_DIR = "未整理";

/** 冊数を見るフォルダ。合本（2 冊）+ 単体（1 冊）+ 目次を読めない 1 件 */
const COUNT_DIR = "冊数";

/** 整理済みの本だけが入った作品フォルダ */
const SHELF_DIR = "[冊数の著者] 冊数の作品";

/** 中に何も無いフォルダ */
const EMPTY_DIR = "空っぽ";

/** 左の行の高さ（2 行組）と、右の行の高さの上限 */
const SOURCE_ROW_HEIGHT = 40;
const PLAN_ROW_MAX_HEIGHT = 30;

/** 解析の投入を遅らせる時間。「解析中」を目で捉えられる長さにする */
const ANALYZE_DELAY_MS = 1500;

let sidecar: Sidecar;
let names: string[];

test.beforeAll(async () => {
  sidecar = await startSidecar();
  mkdirSync(join(sidecar.workDir, ARCHIVE_DIR), { recursive: true });
  names = Array.from(
    { length: MANY },
    (_, index) => `左右 第${String(index + 1).padStart(2, "0")}巻.zip`,
  );
  for (const name of names) {
    writeArchive(sidecar.workDir, `${ARCHIVE_DIR}/${name}`, [
      { name: "001.jpg", color: "#ff0000" },
    ]);
  }

  mkdirSync(join(sidecar.workDir, COUNT_DIR), { recursive: true });
  writeArchive(sidecar.workDir, `${COUNT_DIR}/合本.zip`, [
    { name: "第01巻/001.jpg", color: "#ff0000" },
    { name: "第02巻/001.jpg", color: "#00ff00" },
  ]);
  writeArchive(sidecar.workDir, `${COUNT_DIR}/単体_03.zip`, [
    { name: "001.jpg", color: "#0000ff" },
  ]);
  writeFileSync(
    join(sidecar.workDir, COUNT_DIR, "壊れ_04.zip"),
    "これは ZIP ではありません",
  );
  writeArchive(sidecar.workDir, "単品_05.zip", [
    { name: "001.jpg", color: "#ffff00" },
  ]);
  writeFileSync(
    join(sidecar.workDir, "壊れ単品_06.zip"),
    "これも ZIP ではありません",
  );
  mkdirSync(join(sidecar.workDir, SHELF_DIR), { recursive: true });
  writeArchive(sidecar.workDir, `${SHELF_DIR}/${SHELF_DIR} 第001巻.zip`, [
    { name: "001.jpg", color: "#ff00ff" },
    { name: "002.jpg", color: "#00ffff" },
  ]);
  mkdirSync(join(sidecar.workDir, EMPTY_DIR), { recursive: true });
});

test.afterAll(() => sidecar?.stop());

const pathOf = (name: string) => join(sidecar.workDir, ARCHIVE_DIR, name);

async function openOrganize(page: Page, height = VIEWPORT.height) {
  const output = join(sidecar.workDir, "out");
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width: VIEWPORT.width, height });
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/** 左の「選んで追加」から辿って、名前を指定して入れる */
async function addArchives(page: Page, picked: string[]) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  await page
    .locator(
      `[data-testid="browse-entry"][data-name="${ARCHIVE_DIR}"] .browser-name`,
    )
    .click();
  await expect(
    page.locator('[data-testid="browse-entry"][data-name$=".zip"]'),
  ).toHaveCount(MANY);
  for (const name of picked) {
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${name}"] .browser-name`,
      )
      .click();
  }
  await expect(page.getByTestId("selected-count")).toHaveText(
    `${picked.length} 件`,
  );
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeHidden();
  // 解析が終わって本の行まで生えるのを待つ。伸び切る前の位置を測らない
  await expect(
    page.locator('[data-testid="plan-row"][data-kind="book"]'),
  ).toHaveCount(picked.length);
}

/** 作業ディレクトリの直下にあるものを、ファイルブラウザから 1 つずつ入れる */
async function addTopLevel(
  page: Page,
  entries: { name: string; folder?: boolean }[],
) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  for (const entry of entries) {
    const row = page.locator(
      `[data-testid="browse-entry"][data-name="${entry.name}"]`,
    );
    if (entry.folder) {
      await row.getByRole("button", { name: "フォルダごと追加" }).click();
    } else {
      await row.locator(".browser-name").click();
    }
  }
  await expect(page.getByTestId("selected-count")).toHaveText(
    `${entries.length} 件`,
  );
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeHidden();
}

/** 左の行の 2 行目に出る、そこから出来る冊数 */
function countOf(page: Page, name: string) {
  return page
    .locator(
      `[data-testid="source-row"][data-path="${join(sidecar.workDir, name)}"]`,
    )
    .getByTestId("source-count");
}

/** 左の列の行。右の一覧の行（plan-row）とは別の名前を名乗る */
function sourceRows(page: Page) {
  return page.getByTestId("source-row");
}

function sourceRow(page: Page, name: string) {
  return page.locator(
    `[data-testid="source-row"][data-path="${pathOf(name)}"]`,
  );
}

/** 右の一番外側の行（落としたもの・選んで入れたもの） */
function rootRows(page: Page) {
  return page.locator('[data-testid="plan-row"][data-level="0"]');
}

async function boxOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} の位置が取れない`).not.toBeNull();
  return box!;
}

/**
 * 点線の枠を持つ要素の testid。layout.spec.ts の dashedFrames と同じ見方で、
 * 見えている結果だけを拾う。
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
          Number(style.opacity) > 0 &&
          sides.some(
            (side) =>
              style[`border${side}Style`] === "dashed" &&
              parseFloat(style[`border${side}Width`]) > 0,
          )
        );
      })
      .map((element) => element.dataset.testid || element.tagName);
  });
}

test.describe("ファイル整理: 投入は左、出来上がりは右", () => {
  test("投入した一覧は左の列にあり、出来上がる本の一覧と場所を奪い合わない", async ({
    page,
  }) => {
    // Arrange
    const picked = names.slice(0, 3);
    await openOrganize(page);

    // Act
    await addArchives(page, picked);

    // Assert - 両方の箱が実際に行を抱えている。片方が高さ 0 でも位置の
    // 比較だけなら通ってしまうので、中身と高さを同じテストで確かめる
    await expect(sourceRows(page)).toHaveCount(3);
    await expect(sourceRow(page, picked[1])).toBeVisible();
    await expect(
      page.locator('[data-testid="plan-row"][data-kind="book"]'),
    ).toHaveCount(3);
    const left = await boxOf(page, "dropzone");
    const right = await boxOf(page, "plan-list");
    expect(
      left.x + left.width,
      "投入の箱が出来上がる本の一覧と重なっている",
    ).toBeLessThan(right.x);
    expect(left.height).toBeGreaterThan(VIEWPORT.height * BOX_MIN_RATIO);
    expect(right.height).toBeGreaterThan(VIEWPORT.height * BOX_MIN_RATIO);

    // Assert - 投入の箱は左の列の中にある
    const aside = await boxOf(page, "organize-sidebar");
    expect(left.x).toBeGreaterThanOrEqual(aside.x - SLACK);
    expect(left.x + left.width).toBeLessThanOrEqual(
      aside.x + aside.width + SLACK,
    );
  });

  test("窓の高さを変えても、作品情報とオプションは動かず、投入の箱だけが伸び縮みする", async ({
    page,
  }) => {
    // Arrange
    await openOrganize(page);
    await addArchives(page, names.slice(0, 2));
    const tall = {
      info: (await boxOf(page, "series-info")).height,
      options: (await boxOf(page, "organize-options")).height,
      box: (await boxOf(page, "dropzone")).height,
    };

    // Act
    await page.setViewportSize({
      width: VIEWPORT.width,
      height: SHORT_HEIGHT,
    });
    await expect
      .poll(async () => (await boxOf(page, "dropzone")).height)
      .toBeLessThan(tall.box - BOX_MIN_DELTA);
    const short = {
      info: (await boxOf(page, "series-info")).height,
      options: (await boxOf(page, "organize-options")).height,
      box: (await boxOf(page, "dropzone")).height,
    };

    // Assert - 固定の 2 段は高さを変えない
    expect(Math.abs(tall.info - short.info)).toBeLessThan(SLACK);
    expect(Math.abs(tall.options - short.options)).toBeLessThan(SLACK);
    // Assert - 全部が固定でも上の 2 つは通るので、箱が実際に変わったことも見る
    expect(tall.box - short.box).toBeGreaterThan(BOX_MIN_DELTA);

    // Assert - オプションは列の底に張り付いている
    const aside = await boxOf(page, "organize-sidebar");
    const options = await boxOf(page, "organize-options");
    expect(
      Math.abs(aside.y + aside.height - (options.y + options.height)),
    ).toBeLessThan(SLACK + 1);
  });

  test("左の列そのものはスクロールせず、溢れるのは投入の箱の中だけ", async ({
    page,
  }) => {
    // Arrange
    await openOrganize(page);

    // Act
    await addArchives(page, names);

    // Assert
    const measured = await page.evaluate(() => {
      const aside = document.querySelector<HTMLElement>(
        '[data-testid="organize-sidebar"]',
      )!;
      const list = document.querySelector<HTMLElement>(
        '[data-testid="source-list"]',
      )!;
      return {
        asideScroll: aside.scrollHeight,
        asideClient: aside.clientHeight,
        listScroll: list.scrollHeight,
        listClient: list.clientHeight,
      };
    });
    expect(measured.asideScroll).toBeLessThanOrEqual(
      measured.asideClient + SLACK,
    );
    // 中身が少ないと前半は何もしなくても通る。箱が実際に溢れていることを対にする
    expect(measured.listScroll).toBeGreaterThan(measured.listClient);
  });

  test("投入を外すのは左の × だけで、右の一番外側の行には × も Delete も無い", async ({
    page,
  }) => {
    // Arrange
    const [gone, kept] = names.slice(0, 2);
    await openOrganize(page);
    await addArchives(page, [gone, kept]);

    // Assert - 右の一番外側の行は外す操作を持たない
    await expect(rootRows(page)).toHaveCount(2);
    await expect(rootRows(page).getByTestId("plan-remove")).toHaveCount(0);
    await rootRows(page).first().focus();
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("selected-count")).toHaveText("2 件");

    // Act - 左の × で 1 件外す
    await sourceRow(page, gone).getByTestId("source-remove").click();

    // Assert - 外したものが消え、残したものは左右とも残っている
    await expect(page.getByTestId("selected-count")).toHaveText("1 件");
    await expect(sourceRow(page, gone)).toHaveCount(0);
    await expect(sourceRow(page, kept)).toBeVisible();
    await expect(rootRows(page)).toHaveCount(1);
    await expect(rootRows(page)).toHaveAttribute("data-path", pathOf(kept));
  });

  test("左の行は Delete でも外せる", async ({ page }) => {
    // Arrange
    const [gone, kept] = names.slice(0, 2);
    await openOrganize(page);
    await addArchives(page, [gone, kept]);

    // Act
    await sourceRow(page, gone).focus();
    await page.keyboard.press("Delete");

    // Assert
    await expect(page.getByTestId("selected-count")).toHaveText("1 件");
    await expect(sourceRow(page, gone)).toHaveCount(0);
    await expect(sourceRow(page, kept)).toBeVisible();
  });

  test("左の × は乗せなくても押せる見た目でいる", async ({ page }) => {
    // Arrange
    await openOrganize(page);
    await addArchives(page, names.slice(0, 1));
    await page.mouse.move(VIEWPORT.width - 10, VIEWPORT.height - 10);

    // Act - toBeVisible() は透明でも真になり、子の opacity は親が薄くても
    // "1" を返す。祖先まで辿って掛け合わせた実効値を測る
    const opacity = await sourceRows(page)
      .first()
      .getByTestId("source-remove")
      .evaluate((element) => {
        let value = 1;
        for (
          let node: HTMLElement | null = element as HTMLElement;
          node;
          node = node.parentElement
        ) {
          value *= Number(getComputedStyle(node).opacity);
        }
        return value;
      });

    // Assert
    expect(opacity).toBeGreaterThanOrEqual(MIN_OPACITY);
  });

  test("何も入れていないとき、右は落とす先ではなく出来上がりの予告になる", async ({
    page,
  }) => {
    // Arrange / Act
    await openOrganize(page);

    // Assert - 右の箱は予告の文言を出す
    await expect(page.getByTestId("plan-box")).toContainText(
      "出来上がる本がここに並びます",
    );
    await expect(page.getByTestId("plan-count")).toHaveText("0 冊");

    // Assert - 点線は「落とす先」の印。左の箱ちょうど 1 つだけが持つ。
    // 「1 つ以上」で縛ると右の箱まで点線のままでも通ってしまう
    expect(await dashedFrames(page)).toEqual(["dropzone"]);
  });

  test("フォルダの行に、そこから出来る冊数と実行時に判定する件数が出る", async ({
    page,
  }) => {
    // Arrange - 投入 1 件に対して本が 3 冊出るフォルダ。件数（1 件）と冊数が
    // わざと食い違う素材にする。1 件 = 1 冊だと件数を出すだけの実装でも通る
    await openOrganize(page);

    // Act
    await addTopLevel(page, [
      { name: COUNT_DIR, folder: true },
      { name: "単品_05.zip" },
      { name: "壊れ単品_06.zip" },
    ]);

    // Assert
    await expect(countOf(page, COUNT_DIR)).toHaveText(
      "3 冊 · 1 件は実行時に判定",
      { timeout: 30_000 },
    );
    await expect(countOf(page, "単品_05.zip")).toHaveText("1 冊");
    // 目次を読めない単品は 0 冊と書かない。中身は実行時に展開して分かる
    await expect(countOf(page, "壊れ単品_06.zip")).toHaveText("実行時に判定");
    await expect(countOf(page, "壊れ単品_06.zip")).toHaveAttribute(
      "title",
      /目次を読めない/,
    );
    // フォルダの行はフォルダの印、単品はアーカイブの印
    await expect(
      page.locator(
        `[data-testid="source-row"][data-path="${join(sidecar.workDir, COUNT_DIR)}"]`,
      ),
    ).toHaveAttribute("data-kind", "folder");
    await expect(
      page.locator(
        `[data-testid="source-row"][data-path="${join(sidecar.workDir, "単品_05.zip")}"]`,
      ),
    ).toHaveAttribute("data-kind", "archive");
  });

  test("整理済みの本だけのフォルダは、冊数に整理済みを添える", async ({
    page,
  }) => {
    // Arrange
    await openOrganize(page);

    // Act
    await addTopLevel(page, [{ name: SHELF_DIR, folder: true }]);

    // Assert
    await expect(countOf(page, SHELF_DIR)).toHaveText("1 冊 · 整理済み", {
      timeout: 30_000,
    });
  });

  test("解析中は「解析中」、何も無いフォルダは「アーカイブがありません」", async ({
    page,
  }) => {
    // Arrange - 解析の投入だけを遅らせ、解析中の間を捉えられるようにする
    await openOrganize(page);
    await page.route("**/api/jobs/analyze*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, ANALYZE_DELAY_MS));
      await route.continue();
    });

    // Act
    await addTopLevel(page, [{ name: EMPTY_DIR, folder: true }]);

    // Assert - 解析が終わるまでは「無い」と言わない
    await expect(countOf(page, EMPTY_DIR)).toHaveText("解析中");
    // Assert - 解析が終われば、黙らずに何も無いことを言う
    await expect(countOf(page, EMPTY_DIR)).toHaveText(
      "アーカイブがありません",
      { timeout: 30_000 },
    );
    await expect(countOf(page, EMPTY_DIR)).toHaveAttribute("data-tone", "warn");
  });

  test("左の行は 40px の 2 行組、右の行は 1 行のまま", async ({ page }) => {
    // Arrange
    await openOrganize(page);

    // Act
    await addArchives(page, names.slice(0, 3));

    // Assert - 左右とも実際に測る。片方だけ測ると、高さを揃えただけの
    // 実装（左も 28px）を見逃す
    const left = await Promise.all(
      (await sourceRows(page).all()).map(
        async (row) => (await row.boundingBox())!.height,
      ),
    );
    const right = await Promise.all(
      (await page.getByTestId("plan-row").all()).map(
        async (row) => (await row.boundingBox())!.height,
      ),
    );
    expect(left).toHaveLength(3);
    expect(right.length).toBeGreaterThanOrEqual(6);
    for (const height of left) {
      expect(Math.abs(height - SOURCE_ROW_HEIGHT)).toBeLessThanOrEqual(SLACK);
    }
    for (const height of right) {
      expect(height).toBeLessThanOrEqual(PLAN_ROW_MAX_HEIGHT);
    }
    // 左の行は右の行の名前を名乗らない。名乗ると右の行の検査が左まで拾う
    await expect(sourceRows(page).getByTestId("plan-row")).toHaveCount(0);
  });

  test("著者の候補は欄に重ねて出し、作品情報の高さも投入の箱の位置も変えない", async ({
    page,
  }) => {
    // Arrange - 外部検索の応答を差し替える。先頭が著者に入り、残りが候補
    await openOrganize(page);
    await page.route("**/api/library/suggest*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: "重ねる作品",
          author: "候補の著者A",
          candidates: ["A", "B", "C"].map((mark, index) => ({
            title: `重ねる作品 ${mark}`,
            author: `候補の著者${mark}`,
            source: "AniList",
            similarity: 1 - index * 0.1,
          })),
        }),
      }),
    );
    const before = {
      info: (await boxOf(page, "series-info")).height,
      box: (await boxOf(page, "dropzone")).y,
    };

    // Act
    await page.getByTestId("organize-title").fill("重ねる作品");

    // Assert - 候補が実際に見えている。見えないまま測ると何も変わらないので
    // 高さの検査が素通りする
    await expect(page.getByTestId("organize-author")).toHaveValue(
      "候補の著者A",
    );
    await expect(page.getByTestId("author-candidate")).toHaveCount(3);
    await expect(
      page.locator(
        '[data-testid="author-candidate"][data-author="候補の著者B"]',
      ),
    ).toBeVisible();
    const after = {
      info: (await boxOf(page, "series-info")).height,
      box: (await boxOf(page, "dropzone")).y,
    };
    expect(Math.abs(after.info - before.info)).toBeLessThan(SLACK);
    expect(Math.abs(after.box - before.box)).toBeLessThan(SLACK);

    // Act - 選ぶと閉じる
    await page
      .locator('[data-testid="author-candidate"][data-author="候補の著者B"]')
      .click();

    // Assert
    await expect(page.getByTestId("organize-author")).toHaveValue(
      "候補の著者B",
    );
    await expect(page.getByTestId("author-candidate")).toHaveCount(0);

    // Act / Assert - 札で開き直せ、Esc で閉じる
    await expect(page.getByTestId("author-candidates-toggle")).toContainText(
      "候補 3",
    );
    await page.getByTestId("author-candidates-toggle").click();
    await expect(page.getByTestId("author-candidate")).toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("author-candidate")).toHaveCount(0);
  });

  test("著者に入った 1 件だけの候補は、勝手に開かない", async ({ page }) => {
    // Arrange
    await openOrganize(page);
    await page.route("**/api/library/suggest*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: "ひとつだけ",
          author: "唯一の著者",
          candidates: [
            {
              title: "ひとつだけ",
              author: "唯一の著者",
              source: "AniList",
              similarity: 1,
            },
          ],
        }),
      }),
    );

    // Act
    await page.getByTestId("organize-title").fill("ひとつだけ");

    // Assert - 著者には入る。選び直す相手が無いので一覧は開かないが、
    // 札は残って開ける
    await expect(page.getByTestId("organize-author")).toHaveValue("唯一の著者");
    await expect(page.getByTestId("author-candidates-toggle")).toContainText(
      "候補 1",
    );
    await expect(page.getByTestId("author-candidate")).toHaveCount(0);
  });
});
