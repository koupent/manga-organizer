import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * UI の密度。
 *
 * 「一個一個の要素がバカでかい」という指摘の中身を数値にしたもの。
 * ボタンや文字そのものは既にデスクトップ標準の寸法にあり、大きく見える
 * 原因は箱代（見出し帯・余白・枠）と、行高を決めている隠れた削除ボタン、
 * そして中央 1400px に閉じ込められた列にある。measurable なのはここだけ
 * なので、ここだけを測る。
 */

/** 一覧の 1 行の上限。現在は隠れた削除ボタン（28px）が 41px まで押し上げている */
const ROW_MAX_HEIGHT = 30;

/** 入力欄と既定のボタン。28px を狙い、端数だけ許す */
const CONTROL_MIN_HEIGHT = 27;
const CONTROL_MAX_HEIGHT = 29;

/** アイコンだけのボタン。24px を狙う */
const ICON_MIN_HEIGHT = 23;
const ICON_MAX_HEIGHT = 25;

/** 主操作。ここだけ 32px を残す */
const PRIMARY_MIN_HEIGHT = 31;
const PRIMARY_MAX_HEIGHT = 33;

/** アプリのヘッダーの上限。端数のぶんだけ 40px から緩める */
const HEADER_MAX_HEIGHT = 41;

/** ファイル整理の内容を縦に収める上限（1280x860 で 3 件入れた状態） */
const CONTENT_MAX_HEIGHT = 520;

/** 横幅の検証に使う窓幅と、左右に許す余白 */
const WIDE_VIEWPORT_WIDTH = 1600;
const MAX_GUTTER = 40;

/** 撤去したい中央寄せの上限。これを超えて広がっていれば制限は残っていない */
const OLD_MAX_CONTENT_WIDTH = 1400;

/** 帯を探す対象の見出し */
const CARD_HEADINGS = ["作品情報", "オプション", "処理ログ"];

/** 3 件入れた状態を作るためのアーカイブの数 */
const ARCHIVE_COUNT = 3;

type Band = {
  heading: string;
  background: string;
  surface: string;
  borderBottomWidth: string;
};

declare global {
  interface Window {
    /** ファイル整理の内容をまとめている要素。クラス名に依らず辿る */
    __contentRoot?: () => HTMLElement | null;
  }
}

let sidecar: Sidecar;
let archives: string[];

test.beforeAll(async () => {
  sidecar = await startSidecar();
  archives = Array.from({ length: ARCHIVE_COUNT }, (_, index) =>
    writeArchive(sidecar.workDir, `密度${index + 1}.zip`, [
      { name: "001.jpg", color: "#ff0000" },
    ]),
  );
});

test.afterAll(() => sidecar?.stop());

/**
 * 測定用の足場を入れる。
 *
 * 内容をまとめている要素には testid が無く、クラス名（max-w-[1400px] など）は
 * まさに今回書き換わる所なので、目印にすると実装後に壊れる。作品情報から
 * 処理ログまでを含む一番内側の祖先、という位置関係で辿る。
 */
async function installContentRoot(page: Page) {
  await page.addInitScript(() => {
    window.__contentRoot = () => {
      const title = document.querySelector<HTMLElement>(
        '[data-testid="organize-title"]',
      );
      const log = document.querySelector<HTMLElement>(
        '[data-testid="organize-log"]',
      );
      if (!title || !log) return null;
      let node: HTMLElement = title;
      while (node.parentElement && !node.contains(log)) {
        node = node.parentElement;
      }
      return node.contains(log) ? node : null;
    };
  });
}

async function openOrganize(page: Page, output: string) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/** ファイルブラウザから処理対象を選ぶ。実パスはサーバー側が返す */
async function selectArchives(page: Page, paths: string[]) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  for (const path of paths) {
    const name = path.split("/").pop()!;
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${name}"] .browser-name`,
      )
      .click();
  }
  await expect(page.getByTestId("selected-count")).toHaveText(
    `${paths.length} 件`,
  );
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeHidden();
}

/**
 * 3 件入れたファイル整理を開く。
 *
 * 一覧が空だと行を 1 つも測らないまま緑になる。件数まで確かめてから返す。
 */
async function openOrganizeWithArchives(
  page: Page,
  outputName: string,
): Promise<void> {
  const output = join(sidecar.workDir, outputName);
  mkdirSync(output, { recursive: true });
  await installContentRoot(page);
  await openOrganize(page, output);
  await selectArchives(page, archives);
  await expect(page.getByTestId("selected-item")).toHaveCount(ARCHIVE_COUNT);
}

/** 要素の高さを測る。見えていない要素は測らせない */
async function heightOf(page: Page, testId: string): Promise<number> {
  const target = page.getByTestId(testId);
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (!box) throw new Error(`${testId} の位置が取れませんでした`);
  return box.height;
}

test.describe("UI の密度", () => {
  test("処理対象の一覧の行が 30px 以下に収まる", async ({ page }) => {
    // Arrange - 行の高さは中身で変わる。3 件そろえてから測る
    await page.setViewportSize({ width: 1280, height: 860 });
    await openOrganizeWithArchives(page, "density-row");

    // Act - 3 行ぶんの高さと、行に載っている削除ボタンの高さを集める
    const rows = await page.getByTestId("selected-item").all();
    const heights = await Promise.all(
      rows.map(async (row) => (await row.boundingBox())!.height),
    );
    const removeHeights = await Promise.all(
      rows.map(
        async (row) =>
          (await row.getByTestId("selected-remove").boundingBox())!.height,
      ),
    );

    // Assert - 1 行も測らないまま通らないようにする
    expect(heights).toHaveLength(ARCHIVE_COUNT);
    for (const height of heights) {
      expect(
        height,
        `行の高さ ${height}px が ${ROW_MAX_HEIGHT}px を超えている`,
      ).toBeLessThanOrEqual(ROW_MAX_HEIGHT);
    }

    // Assert - 行高を決めていた削除ボタン自体が縮んでいること。
    // 行だけ固定して中のボタンを隠す逃げ方だと、押し所が消えるだけで直らない
    for (const height of removeHeights) {
      expect(
        height,
        `削除ボタンの高さ ${height}px が ${ICON_MAX_HEIGHT}px を超えている`,
      ).toBeLessThanOrEqual(ICON_MAX_HEIGHT);
      expect(height).toBeGreaterThanOrEqual(ICON_MIN_HEIGHT);
    }
  });

  test("入力欄が 28px になる", async ({ page }) => {
    // Arrange
    await page.setViewportSize({ width: 1280, height: 860 });
    await installContentRoot(page);
    await openOrganize(page, join(sidecar.workDir, "density-input"));

    // Act & Assert - 1 箇所だけ細工しても通らないよう、画面上の入力欄を全部見る
    for (const testId of [
      "organize-title",
      "organize-author",
      "output-directory",
    ]) {
      const height = await heightOf(page, testId);
      expect(height, `${testId} の高さが ${height}px`).toBeGreaterThanOrEqual(
        CONTROL_MIN_HEIGHT,
      );
      expect(height, `${testId} の高さが ${height}px`).toBeLessThanOrEqual(
        CONTROL_MAX_HEIGHT,
      );
    }
  });

  test("既定の寸法のボタンが 28px になる", async ({ page }) => {
    // Arrange
    await page.setViewportSize({ width: 1280, height: 860 });
    await installContentRoot(page);
    await openOrganize(page, join(sidecar.workDir, "density-button"));

    // Act & Assert - browse-output は寸法を指定していない既定のボタン、
    // open-browser は今 sm を指定しているボタン。既定を詰めた後は両方 28px に揃う
    for (const testId of ["browse-output", "open-browser"]) {
      const height = await heightOf(page, testId);
      expect(height, `${testId} の高さが ${height}px`).toBeGreaterThanOrEqual(
        CONTROL_MIN_HEIGHT,
      );
      expect(height, `${testId} の高さが ${height}px`).toBeLessThanOrEqual(
        CONTROL_MAX_HEIGHT,
      );
    }
  });

  test("32px なのは主操作のボタンだけになる", async ({ page }) => {
    // Arrange - 一覧の行や削除ボタンも数に入るよう、3 件入れた状態で見る
    await page.setViewportSize({ width: 1280, height: 860 });
    await openOrganizeWithArchives(page, "density-primary");

    // Act - 主操作の高さと、画面に出ている操作要素の高さを集める
    const confirmHeight = await heightOf(page, "confirm");
    const others = await page.evaluate(
      ([min, max]) =>
        [...document.querySelectorAll<HTMLElement>("button, input")]
          .filter((element) => element.dataset.testid !== "confirm")
          .filter((element) => element.offsetParent !== null)
          .map((element) => ({
            testId: element.dataset.testid ?? "",
            label: (element.textContent ?? "").trim().slice(0, 20),
            height:
              Math.round(element.getBoundingClientRect().height * 100) / 100,
          }))
          .filter((item) => item.height >= min && item.height <= max),
      [PRIMARY_MIN_HEIGHT, PRIMARY_MAX_HEIGHT],
    );

    // Assert - 主操作は 32px のまま
    expect(confirmHeight).toBeGreaterThanOrEqual(PRIMARY_MIN_HEIGHT);
    expect(confirmHeight).toBeLessThanOrEqual(PRIMARY_MAX_HEIGHT);

    // Assert - 同じ高さの操作が他に無いから、主操作が主操作に見える
    expect(
      others,
      `主操作以外にも 32px の操作がある: ${JSON.stringify(others)}`,
    ).toEqual([]);
  });

  test("アプリのヘッダーが 40px 以下に収まる", async ({ page }) => {
    // Arrange
    await page.setViewportSize({ width: 1280, height: 860 });
    await installContentRoot(page);
    await openOrganize(page, join(sidecar.workDir, "density-header"));

    // Act
    const header = page.locator("header");
    await expect(header).toBeVisible();
    const height = (await header.boundingBox())!.height;

    // Assert
    expect(height, `ヘッダーの高さが ${height}px`).toBeLessThanOrEqual(
      HEADER_MAX_HEIGHT,
    );
  });

  test("ファイル整理の内容が 1280x860 で縦に収まる", async ({ page }) => {
    // Arrange - 実際に使う窓の大きさで、3 件入れた通常の状態を作る
    await page.setViewportSize({ width: 1280, height: 860 });
    await openOrganizeWithArchives(page, "density-fit");

    // Act - 作品情報から処理ログまでを含む領域の高さ
    const measured = await page.evaluate(() => {
      const root = window.__contentRoot?.();
      if (!root) return null;
      const rect = root.getBoundingClientRect();
      return { height: rect.height, top: rect.top };
    });

    // Assert - 測る対象が見つからないまま通らないようにする
    expect(measured, "内容をまとめている要素が見つからない").not.toBeNull();
    expect(
      measured!.height,
      `内容の高さが ${measured!.height}px`,
    ).toBeLessThanOrEqual(CONTENT_MAX_HEIGHT);
  });

  test("カードの見出しに背景の帯が付かない", async ({ page }) => {
    // Arrange
    await page.setViewportSize({ width: 1280, height: 860 });
    await openOrganizeWithArchives(page, "density-band");

    // Act - 見出しから面（カード）の外枠までの間に、色の付いた帯や区切り線が
    // 挟まっていないかを見る。実装の中身ではなく、見えている結果だけで判断する
    const found = await page.evaluate((headings) => {
      const isTransparent = (color: string) =>
        color === "transparent" ||
        color === "rgba(0, 0, 0, 0)" ||
        /\/\s*0\s*\)$/.test(color);

      const root = window.__contentRoot?.();
      if (!root) return null;

      const bands: {
        heading: string;
        background: string;
        surface: string;
        borderBottomWidth: string;
      }[] = [];
      const missing: string[] = [];

      for (const text of headings) {
        const heading = [
          ...root.querySelectorAll<HTMLElement>("h1, h2, h3"),
        ].find((element) => element.textContent?.trim() === text);
        if (!heading) {
          missing.push(text);
          continue;
        }

        // 面の外枠は、内容をまとめている要素の直下にある
        let surface: HTMLElement = heading;
        while (surface.parentElement && surface.parentElement !== root) {
          surface = surface.parentElement;
        }
        const surfaceBackground = getComputedStyle(surface).backgroundColor;

        for (
          let node: HTMLElement | null = heading;
          node && node !== surface;
          node = node.parentElement
        ) {
          const style = getComputedStyle(node);
          const tinted =
            !isTransparent(style.backgroundColor) &&
            style.backgroundColor !== surfaceBackground;
          const ruled = parseFloat(style.borderBottomWidth) > 0;
          if (tinted || ruled) {
            bands.push({
              heading: text,
              background: style.backgroundColor,
              surface: surfaceBackground,
              borderBottomWidth: style.borderBottomWidth,
            });
          }
        }
      }
      return { bands, missing };
    }, CARD_HEADINGS);

    // Assert - 見出しが見つからないまま「帯なし」で通らないようにする
    expect(found, "内容をまとめている要素が見つからない").not.toBeNull();
    expect(found!.missing, "見出しが見つからない").toEqual([]);

    // Assert - 見出しは文字だけで、面から浮いた帯にしない
    const bands: Band[] = found!.bands;
    expect(bands, `見出しが帯の中にある: ${JSON.stringify(bands)}`).toEqual([]);
  });

  test("広い窓で内容が中央 1400px に閉じ込められない", async ({ page }) => {
    // Arrange - 1400px の制限が見える幅にする
    await page.setViewportSize({ width: WIDE_VIEWPORT_WIDTH, height: 900 });
    await openOrganizeWithArchives(page, "density-width");

    // Act
    const measured = await page.evaluate(() => {
      const root = window.__contentRoot?.();
      if (!root) return null;
      const rect = root.getBoundingClientRect();
      return {
        left: rect.left,
        right: window.innerWidth - rect.right,
        width: rect.width,
        viewport: window.innerWidth,
      };
    });

    // Assert
    expect(measured, "内容をまとめている要素が見つからない").not.toBeNull();
    expect(measured!.viewport).toBe(WIDE_VIEWPORT_WIDTH);
    expect(measured!.width, `内容の幅が ${measured!.width}px`).toBeGreaterThan(
      OLD_MAX_CONTENT_WIDTH,
    );

    // Assert - 左右に大きな余白を残した中央寄せになっていない
    expect(
      measured!.left,
      `左の余白が ${measured!.left}px`,
    ).toBeLessThanOrEqual(MAX_GUTTER);
    expect(
      measured!.right,
      `右の余白が ${measured!.right}px`,
    ).toBeLessThanOrEqual(MAX_GUTTER);
  });
});
