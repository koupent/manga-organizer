import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * 元 → 結果 を見せ、巻数をその場で直せるようにする（サイドバー案 段階 5）。
 *
 * 巻数の根拠（#114）と訂正の受け口（#115 #116）はサイドカーに入っている。
 * 画面が受け取るのは ``volume_origin`` / ``volume_source_name`` で、
 * 名前のどこを巻数として読んだのか（型・最後の数字・並び順）を行に出す。
 *
 * - 本の行は「元の名前 → 出来上がる名前」。矢印は全部の行で同じ位置に揃う
 * - 読んだ数字だけを塗る。数字が無く並び順を当てはめただけなら「並び順 N」
 * - 名前の中の「第NNN巻」を押すとその場で直せる。Enter で決める、Esc で
 *   やめる、↑↓ で隣の本へ、Ctrl+Enter で同じ入れ物の下の本に続き番号
 * - 直した値は解析をやり直しても消えない。整理済みの本は直せない
 * - 作る本どうしで同じ名前になるものには「巻数が重なる」
 */

const AUTHOR = "訂正の著者";
const TITLE = "訂正の作品";

/** 放り込むフォルダ。合本（数字の無い 上/下）・最後の数字・型 の 3 通り */
const FOLDER = "訂正";

/** 整理済みの本だけが入った作品フォルダ */
const SHELF = "[棚の著者] 棚の作品";

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
  mkdirSync(join(sidecar.workDir, FOLDER), { recursive: true });
  writeArchive(sidecar.workDir, `${FOLDER}/合本.zip`, [
    { name: "上/001.jpg", color: "#ff0000" },
    { name: "下/001.jpg", color: "#00ff00" },
  ]);
  writeArchive(sidecar.workDir, `${FOLDER}/raw_07_fix3.zip`, [
    { name: "001.jpg", color: "#0000ff" },
  ]);
  writeArchive(sidecar.workDir, `${FOLDER}/第05巻.zip`, [
    { name: "001.jpg", color: "#ffff00" },
  ]);
  mkdirSync(join(sidecar.workDir, SHELF), { recursive: true });
  writeArchive(sidecar.workDir, `${SHELF}/${SHELF} 第001巻.zip`, [
    { name: "001.jpg", color: "#ff00ff" },
    { name: "002.jpg", color: "#00ffff" },
  ]);
  writeArchive(sidecar.workDir, "後から足す_09.zip", [
    { name: "001.jpg", color: "#888888" },
  ]);
});

test.afterAll(() => sidecar?.stop());

async function openOrganize(page: Page, output: string) {
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ author: null, candidates: [] }),
    }),
  );
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await page.getByTestId("organize-title").fill(TITLE);
  await page.getByTestId("organize-author").fill(AUTHOR);
}

/** 作業ディレクトリの直下にあるものを入れる */
async function add(page: Page, names: { name: string; folder?: boolean }[]) {
  await page.getByTestId("open-browser").click();
  for (const entry of names) {
    const row = page.locator(
      `[data-testid="browse-entry"][data-name="${entry.name}"]`,
    );
    if (entry.folder) {
      await row.getByRole("button", { name: "フォルダごと追加" }).click();
    } else {
      await row.locator(".browser-name").click();
    }
  }
  await page.getByTestId("browse-close").click();
}

/** 本の行。元のアーカイブとその中の位置で名指しする */
function book(page: Page, archive: string, entry = "") {
  return page.locator(
    `[data-testid="plan-row"][data-kind="book"]` +
      `[data-source="${join(sidecar.workDir, FOLDER, archive)}"]` +
      `[data-entry="${entry}"]`,
  );
}

const name = (volume: string) => `[${AUTHOR}] ${TITLE} ${volume}.zip`;

async function waitForBooks(page: Page, count: number) {
  await expect(
    page.locator('[data-testid="plan-row"][data-kind="book"]'),
  ).toHaveCount(count, { timeout: 30_000 });
  await expect(page.getByTestId("confirm")).toBeEnabled({ timeout: 30_000 });
}

/** 札を押して値を打つ。決め方（Enter など）は呼び出し側が押す */
async function typeVolume(
  page: Page,
  row: ReturnType<typeof book>,
  value: string,
) {
  await row.getByTestId("volume-chip").click();
  const input = row.getByTestId("volume-input");
  await expect(input).toBeFocused();
  await input.fill(value);
}

test.describe("元 → 結果 と巻数の訂正", () => {
  test("読んだ数字を塗り、並び順なら「並び順 N」と言い、矢印を揃える", async ({
    page,
  }) => {
    // Arrange / Act
    await openOrganize(page, join(sidecar.workDir, "out-origin"));
    await add(page, [{ name: FOLDER, folder: true }]);
    await waitForBooks(page, 4);

    // Assert - 最後の数字を拾った本は、その数字だけが塗られる（怪しいので琥珀）
    const raw = book(page, "raw_07_fix3.zip");
    await expect(raw.getByTestId("plan-row-path")).toContainText(
      "raw_07_fix3.zip",
    );
    await expect(raw.getByTestId("volume-read")).toHaveText("3");
    await expect(raw.getByTestId("volume-read")).toHaveAttribute(
      "data-tone",
      "warn",
    );
    // Assert - 型に当たった本は確かな読み（青）
    await expect(
      book(page, "第05巻.zip").getByTestId("volume-read"),
    ).toHaveAttribute("data-tone", "brand");
    // Assert - 数字が無い本は、並び順を当てはめたことを言う
    await expect(book(page, "合本.zip", "上")).toContainText("並び順 1");
    await expect(book(page, "合本.zip", "下")).toContainText("並び順 2");

    // Assert - 矢印は入れ子の深さが違う行でも同じ位置に並ぶ
    const xs = await page
      .locator('[data-testid="plan-row"][data-kind="book"]')
      .getByTestId("volume-arrow")
      .evaluateAll((arrows) =>
        arrows.map((arrow) => Math.round(arrow.getBoundingClientRect().x)),
      );
    expect(xs).toHaveLength(4);
    expect(new Set(xs).size, `矢印の位置が揃っていない: ${xs}`).toBe(1);
  });

  test("直した巻数が名前と印と実行に効き、依頼には直した本だけが巻数を載せる", async ({
    page,
  }) => {
    // Arrange
    const output = join(sidecar.workDir, "out-correct");
    let organized: { books?: { source: string; volume?: unknown }[] } = {};
    await page.route("**/api/jobs/organize*", async (route) => {
      organized = JSON.parse(route.request().postData() ?? "{}");
      await route.continue();
    });
    await openOrganize(page, output);
    await add(page, [{ name: FOLDER, folder: true }]);
    await waitForBooks(page, 4);
    const raw = book(page, "raw_07_fix3.zip");
    await expect(raw).toHaveAttribute("data-output-name", name("第003巻"));
    await expect(raw.getByTestId("plan-row-warning")).toHaveAttribute(
      "title",
      /巻数が怪しい/,
    );

    // Act
    await typeVolume(page, raw, "7");
    await page.keyboard.press("Enter");

    // Assert - 名前が変わり、「怪しい」の印は消え、直したことが状態の行に出る
    await expect(raw).toHaveAttribute("data-output-name", name("第007巻"));
    await expect(
      raw.locator('[data-testid="plan-row-warning"][title*="巻数が怪しい"]'),
    ).toHaveCount(0);
    await expect(raw.getByTestId("volume-chip")).toHaveAttribute(
      "data-corrected",
      "true",
    );
    await expect(page.getByTestId("organize-status")).toContainText(
      "1 冊の巻数を直した",
    );

    // Act - 実行する
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 60_000 },
    );

    // Assert - 依頼には直した本だけが巻数を載せる。直していない本に
    // volume を載せると、既定の依頼が「全冊の巻数を消す」依頼になる
    const sent = organized.books ?? [];
    const rawSource = join(sidecar.workDir, FOLDER, "raw_07_fix3.zip");
    expect(sent.find((item) => item.source === rawSource)?.volume).toEqual({
      number: 7,
    });
    expect(
      sent
        .filter((item) => item.source !== rawSource)
        .map((item) => "volume" in item),
    ).toEqual([false, false, false]);

    // Assert - 出来たファイルの名前に効いている。直していない本は自動のまま
    const made = readdirSync(join(output, `[${AUTHOR}] ${TITLE}`));
    expect(made).toContain(name("第007巻"));
    expect(made).toContain(name("第005巻"));
  });

  test("Ctrl+Enter で同じ入れ物の下の本に続き番号を振り、隣の入れ物は変えない", async ({
    page,
  }) => {
    // Arrange
    await openOrganize(page, join(sidecar.workDir, "out-fill"));
    await add(page, [{ name: FOLDER, folder: true }]);
    await waitForBooks(page, 4);

    // Act
    await typeVolume(page, book(page, "合本.zip", "上"), "4");
    await page.keyboard.press("Control+Enter");

    // Assert
    await expect(book(page, "合本.zip", "上")).toHaveAttribute(
      "data-output-name",
      name("第004巻"),
    );
    await expect(book(page, "合本.zip", "下")).toHaveAttribute(
      "data-output-name",
      name("第005巻"),
    );
    // 対照。別の入れ物の本は自動のまま
    await expect(book(page, "raw_07_fix3.zip")).toHaveAttribute(
      "data-output-name",
      name("第003巻"),
    );
  });

  test("↓ で決めて隣の本の札へ移り、Esc ならやめる", async ({ page }) => {
    // Arrange
    await openOrganize(page, join(sidecar.workDir, "out-move"));
    await add(page, [{ name: FOLDER, folder: true }]);
    await waitForBooks(page, 4);
    const upper = book(page, "合本.zip", "上");
    const lower = book(page, "合本.zip", "下");

    // Act
    await typeVolume(page, upper, "11");
    await page.keyboard.press("ArrowDown");

    // Assert - 上は決まり、下の札が開いている
    await expect(upper).toHaveAttribute("data-output-name", name("第011巻"));
    await expect(lower.getByTestId("volume-input")).toBeFocused();

    // Act - 打ちかけてやめる
    await lower.getByTestId("volume-input").fill("99");
    await page.keyboard.press("Escape");

    // Assert
    await expect(lower).toHaveAttribute("data-output-name", name("第002巻"));
    await expect(lower.getByTestId("volume-input")).toHaveCount(0);
  });

  test("直した値は解析をやり直しても残る", async ({ page }) => {
    // Arrange
    await openOrganize(page, join(sidecar.workDir, "out-keep"));
    await add(page, [{ name: FOLDER, folder: true }]);
    await waitForBooks(page, 4);
    const raw = book(page, "raw_07_fix3.zip");
    await typeVolume(page, raw, "7");
    await page.keyboard.press("Enter");
    await expect(raw).toHaveAttribute("data-output-name", name("第007巻"));

    // Act - 投入を足すと解析をやり直す
    await add(page, [{ name: "後から足す_09.zip" }]);
    await waitForBooks(page, 5);

    // Assert
    await expect(raw).toHaveAttribute("data-output-name", name("第007巻"));
  });

  test("作る本どうしで同じ名前になるなら、両方に「巻数が重なる」を出す", async ({
    page,
  }) => {
    // Arrange
    await openOrganize(page, join(sidecar.workDir, "out-collide"));
    await add(page, [{ name: FOLDER, folder: true }]);
    await waitForBooks(page, 4);

    // Act - 第05巻.zip と同じ 5 にする
    await typeVolume(page, book(page, "合本.zip", "下"), "5");
    await page.keyboard.press("Enter");

    // Assert - 重なった 2 冊の両方に印。後ろの名前には _1 が付く
    for (const row of [
      book(page, "合本.zip", "下"),
      book(page, "第05巻.zip"),
    ]) {
      await expect(row.getByTestId("plan-row-warning")).toHaveAttribute(
        "title",
        /名前が重なる/,
      );
    }
    const names = [
      await book(page, "合本.zip", "下").getAttribute("data-output-name"),
      await book(page, "第05巻.zip").getAttribute("data-output-name"),
    ];
    expect(names.sort()).toEqual([name("第005巻"), name("第005巻_1")].sort());

    // Act - 片方を外すと重ならない（外した本は名前を取らない）
    await book(page, "第05巻.zip").getByTestId("plan-check").click();

    // Assert
    await expect(
      book(page, "合本.zip", "下").locator(
        '[data-testid="plan-row-warning"][title*="名前が重なる"]',
      ),
    ).toHaveCount(0);
    await expect(book(page, "合本.zip", "下")).toHaveAttribute(
      "data-output-name",
      name("第005巻"),
    );
  });

  test("整理済みの本は巻数を直せない", async ({ page }) => {
    // Arrange / Act
    await openOrganize(page, join(sidecar.workDir, "out-shelf"));
    await add(page, [
      { name: SHELF, folder: true },
      { name: FOLDER, folder: true },
    ]);
    await waitForBooks(page, 5);

    // Assert - 整理済みの行には札が無い。整理済みでない行には有る（対照）
    const shelf = page.locator(
      '[data-testid="plan-row"][data-kind="book"][data-organized="true"]',
    );
    await expect(shelf).toHaveCount(1);
    await expect(shelf.getByTestId("volume-chip")).toHaveCount(0);
    await expect(
      book(page, "raw_07_fix3.zip").getByTestId("volume-chip"),
    ).toHaveCount(1);
  });
});
