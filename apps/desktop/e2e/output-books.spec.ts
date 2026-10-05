import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * 出力先に既にある本（#178）。
 *
 * 前回作った同じ巻が出力先に残っていると、一覧の予告（番号なし・_1）と
 * 実際に出来る名前（上書きを避けた _2）が食い違っていた。出力先の本を一覧に
 * 出して先着として数え、要らない方をごみ箱へ移せば残りを詰め直す。
 */

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => sidecar?.stop());

const AUTHOR = "先着の著者";
const TITLE = "先着の作品";
const SERIES = `[${AUTHOR}] ${TITLE}`;
const VOLUME_3 = `${SERIES} 第003巻`;

/** 枚数で大きさを変えた本。付け替えた後にどのファイルだったかを大きさで見分ける */
function pages(count: number, color: string) {
  return Array.from({ length: count }, (_, index) => ({
    name: `${String(index + 1).padStart(3, "0")}.jpg`,
    color,
  }));
}

/** 出来上がりの名前で引いた行。出力先の本か今回の本かで絞れる */
function row(page: Page, name: string, existing: boolean) {
  return page.locator(
    `[data-testid="plan-row"][data-output-name="${name}"]` +
      (existing ? "[data-existing]" : ":not([data-existing])"),
  );
}

/** 出力先の作品フォルダにあるファイル。名前の順 */
function filesIn(folder: string): string[] {
  return readdirSync(folder).sort();
}

async function trashRow(page: Page, target: ReturnType<typeof row>) {
  await target.getByTestId("plan-trash").click();
  await page.getByTestId("trash-confirm").click();
}

test("出力先にある同じ巻を先着として一覧に出し、次の番号で作り、消せば番号を詰め直す（#178）", async ({
  page,
}) => {
  // Arrange - 出力先に前回の 3 巻が 2 冊（番号なし・_1）。今回は 3 巻を 1 冊足す
  const output = join(sidecar.workDir, "out-first-come");
  const folder = join(output, SERIES);
  mkdirSync(folder, { recursive: true });
  writeArchive(
    sidecar.workDir,
    join("out-first-come", SERIES, `${VOLUME_3}.zip`),
    pages(2, "#aa0000"),
  );
  writeArchive(
    sidecar.workDir,
    join("out-first-come", SERIES, `${VOLUME_3}_1.zip`),
    pages(3, "#00aa00"),
  );
  const source = writeArchive(
    sidecar.workDir,
    "先着_03.zip",
    pages(5, "#0000aa"),
  );
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ author: null, candidates: [] }),
    }),
  );
  // 出力先の読み直しと付け替えを遅らせ、読み直しの答えが付け替えの最中に
  // 届く順にする。届いた答えに付け替えを重ねて当てると、行が二重に出る
  await page.route("**/api/output/books*", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.fulfill({ response });
  });
  await page.route("**/api/files/rename*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await page.getByTestId("organize-title").fill(TITLE);
  await page.getByTestId("organize-author").fill(AUTHOR);
  await page.getByTestId("open-browser").click();
  await page
    .locator(
      '[data-testid="browse-entry"][data-name="先着_03.zip"] .browser-name',
    )
    .click();
  await page.getByTestId("open-browser").click();

  // Assert - 出力先の 2 冊が、同じ巻の今回の本の前に並ぶ
  const books = page.locator('[data-testid="plan-row"][data-kind="book"]');
  await expect(books).toHaveCount(3);
  expect(
    await books.evaluateAll((nodes) =>
      nodes.map((node) => [
        node.getAttribute("data-source"),
        node.hasAttribute("data-existing"),
      ]),
    ),
  ).toEqual([
    [join(folder, `${VOLUME_3}.zip`), true],
    [join(folder, `${VOLUME_3}_1.zip`), true],
    [source, false],
  ]);

  // Assert - 出力先の本は元の名前を持たず、チェックも無い。番号なしは整理済み、
  // 番号付きは同じ巻の重複として警告する
  const plain = row(page, `${VOLUME_3}.zip`, true);
  const numbered = row(page, `${VOLUME_3}_1.zip`, true);
  for (const existing of [plain, numbered]) {
    await expect(existing.getByTestId("plan-row-path")).toHaveText("");
    await expect(existing.getByTestId("plan-check")).toHaveCount(0);
  }
  await expect(plain.getByTestId("plan-row-state")).toHaveText("整理済み");
  await expect(numbered.getByTestId("plan-row-warning")).toHaveAttribute(
    "title",
    /^同じ巻の本が 3 冊あります。番号の付いた本は重複です/,
  );

  // Assert - 出力先に同じ巻があるので、今回の本は既定で外れている
  const added = page.locator(
    `[data-testid="plan-row"][data-source="${source}"]`,
  );
  await expect(added.getByTestId("plan-check")).not.toBeChecked();

  // Act - 今回の本も入れる
  await added.getByTestId("plan-check").click();

  // Assert - 出力先の 2 冊の次、_2 と予告する
  await expect(added).toHaveAttribute("data-output-name", `${VOLUME_3}_2.zip`);

  // Act - 整理する
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("organize-status")).toContainText(
    "整理しました",
    { timeout: 30_000 },
  );

  // Assert - 予告どおりの名前で出来て、重複として警告する
  expect(filesIn(folder)).toEqual([
    `${VOLUME_3}.zip`,
    `${VOLUME_3}_1.zip`,
    `${VOLUME_3}_2.zip`,
  ]);
  const made = row(page, `${VOLUME_3}_2.zip`, false);
  await expect(made).toHaveAttribute(
    "data-made",
    join(folder, `${VOLUME_3}_2.zip`),
  );
  await expect(made.getByTestId("plan-row-warning")).toHaveAttribute(
    "data-duplicate",
    "true",
  );
  const sizeOf = (name: string) => statSync(join(folder, name)).size;
  const firstSize = sizeOf(`${VOLUME_3}_1.zip`);
  const madeSize = sizeOf(`${VOLUME_3}_2.zip`);

  // Act - 番号なしの本をごみ箱へ移す
  await trashRow(page, plain);

  // Assert - 残りを先着順に詰め直す。_1 だった本が番号なしに、今回の本が _1 に
  await expect(page.getByTestId("organize-status")).toContainText(
    "番号を詰め直しました",
  );
  expect(filesIn(folder)).toEqual([`${VOLUME_3}.zip`, `${VOLUME_3}_1.zip`]);
  expect(sizeOf(`${VOLUME_3}.zip`)).toBe(firstSize);
  expect(sizeOf(`${VOLUME_3}_1.zip`)).toBe(madeSize);
  await expect(
    row(page, `${VOLUME_3}.zip`, true).getByTestId("plan-row-state"),
  ).toHaveText("整理済み");
  await expect(
    row(page, `${VOLUME_3}_1.zip`, false).getByTestId("plan-row-warning"),
  ).toHaveAttribute("data-duplicate", "true");

  // Act - 今回作った本もごみ箱へ移し、1 冊に絞る
  await trashRow(page, row(page, `${VOLUME_3}_1.zip`, false));

  // Assert - 残った 1 冊は番号なしで整理済み。消した本はチェックを外した姿へ戻り、
  // 次に整理しても作り直さない
  expect(filesIn(folder)).toEqual([`${VOLUME_3}.zip`]);
  await expect(
    row(page, `${VOLUME_3}.zip`, true).getByTestId("plan-row-state"),
  ).toHaveText("整理済み");
  await expect(added.getByTestId("plan-check")).not.toBeChecked();
  await expect(page.getByTestId("confirm")).toBeDisabled();
});

test("出力先の本は、作品名・著者が違えば一覧に出さない（#178）", async ({
  page,
}) => {
  // Arrange - 出力先には別の作品と、規則に合わない名前のファイルだけがある
  const output = join(sidecar.workDir, "out-other-series");
  mkdirSync(join(output, SERIES), { recursive: true });
  writeArchive(
    sidecar.workDir,
    join("out-other-series", SERIES, `${VOLUME_3}.zip`),
    pages(1, "#aa0000"),
  );
  writeArchive(
    sidecar.workDir,
    join("out-other-series", SERIES, "手で置いた本.zip"),
    pages(1, "#00aa00"),
  );
  writeArchive(sidecar.workDir, "別作品_03.zip", pages(1, "#0000aa"));
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
  await page.getByTestId("organize-title").fill("別の作品");
  await page.getByTestId("organize-author").fill(AUTHOR);
  await page.getByTestId("open-browser").click();
  await page
    .locator(
      '[data-testid="browse-entry"][data-name="別作品_03.zip"] .browser-name',
    )
    .click();
  await page.getByTestId("open-browser").click();
  const books = page.locator('[data-testid="plan-row"][data-kind="book"]');
  await expect(books).toHaveCount(1);

  // Act - 作品名を出力先の作品に合わせる（作品名を変えると著者は空に戻る）
  await page.getByTestId("organize-title").fill(TITLE);
  await page.getByTestId("organize-author").fill(AUTHOR);

  // Assert - 規則どおりの名前の本だけが出る。手で置いた本は出ない
  await expect(page.locator("[data-existing]")).toHaveCount(1);
  await expect(row(page, `${VOLUME_3}.zip`, true)).toHaveCount(1);
  await expect(books).toHaveCount(2);
});
