import { mkdirSync } from "node:fs";
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
});
