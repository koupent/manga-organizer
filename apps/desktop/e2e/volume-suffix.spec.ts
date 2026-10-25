import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/** 手元のエージェント用。CI には無いので、書けたときだけ写す */
const AGENT_SHOT_DIR =
  "/cursor/stores/bc-c3fc470f-a764-41b2-9a2c-bcb4a3816014/media/volume-suffix";

/**
 * 同じ巻が重なった ``第002巻_3`` は、巻 2 に種類番号 3 が付いた巻数。
 *
 * ``_1`` は整理が名前の衝突で足す番号で、``エイジ`` のような 1 語のラベルではない。
 * 種類番号を落とすと ``第002巻`` や ``第002巻_`` になり、``_1`` と ``_3`` が
 * 同じ名前に潰れる。``第001巻`` とラベルは今までどおり。ページが連番でない
 * 本も、種類番号だけは残す。規則に合わない名前は警告のまま。
 */

const AUTHOR = "押見修造";
const TITLE = "血の轍";
const LABEL = "エイジ";
const FOLDER = "轍の蔵書";

const volumeName = `[${AUTHOR}] ${TITLE} 第001巻.zip`;
const kindOne = `[${AUTHOR}] ${TITLE} 第002巻_1.zip`;
const kindThree = `[${AUTHOR}] ${TITLE} 第002巻_3.zip`;
const labelName = `[${AUTHOR}] ${TITLE} ${LABEL}.zip`;
const roughName = `[${AUTHOR}] ${TITLE} 第003巻_2.zip`;
const looseName = "loose.zip";

const pages = [
  { name: "001.jpg", color: "#336699" },
  { name: "002.jpg", color: "#993333" },
];

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
  mkdirSync(join(sidecar.workDir, FOLDER), { recursive: true });
  for (const name of [volumeName, kindOne, kindThree, labelName]) {
    writeArchive(sidecar.workDir, `${FOLDER}/${name}`, pages);
  }
  writeArchive(sidecar.workDir, `${FOLDER}/${roughName}`, [
    { name: "cover.jpg", color: "#225544" },
    { name: "note.jpg", color: "#442222" },
  ]);
  writeArchive(sidecar.workDir, `${FOLDER}/${looseName}`, [
    { name: "001.jpg", color: "#666666" },
  ]);
});

test.afterAll(() => sidecar?.stop());

async function openOrganize(page: Page) {
  const output = join(sidecar.workDir, "out-suffix");
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
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

async function addFolder(page: Page) {
  await page.getByTestId("open-browser").click();
  await page
    .locator(`[data-testid="browse-entry"][data-name="${FOLDER}"]`)
    .getByRole("button", { name: "フォルダごと追加" })
    .click();
  await page.getByTestId("browse-close").click();
}

function book(page: Page, fileName: string): Locator {
  return page.locator(
    `[data-testid="plan-row"][data-kind="book"][data-source=${JSON.stringify(
      join(sidecar.workDir, FOLDER, fileName),
    )}]`,
  );
}

test("種類番号付きの巻は整理済みのまま残り、落ちた名前に潰れない", async ({
  page,
}, testInfo) => {
  await openOrganize(page);
  await addFolder(page);
  await expect(
    page.locator('[data-testid="plan-row"][data-kind="book"]'),
  ).toHaveCount(6, { timeout: 30_000 });

  // 名前の列を広げて、種類番号が画面に収まるようにする
  const resize = page.getByTestId("resize-name");
  await resize.focus();
  for (let step = 0; step < 16; step += 1) {
    await resize.press("ArrowRight");
  }

  const plain = book(page, volumeName);
  await expect(plain).toHaveAttribute("data-organized", "true");
  await expect(plain).toHaveAttribute("data-output-name", volumeName);
  await expect(plain.getByTestId("plan-row-state")).toHaveText("整理済み");
  await expect(plain.getByTestId("plan-row-warning")).toHaveCount(0);

  for (const [fileName, suffix] of [
    [kindOne, "1"],
    [kindThree, "3"],
  ] as const) {
    const row = book(page, fileName);
    await expect(row).toHaveAttribute("data-organized", "true");
    await expect(row).toHaveAttribute("data-output-name", fileName);
    await expect(row.getByTestId("plan-row-name")).toContainText(
      `第002巻_${suffix}`,
    );
    await expect(row.getByTestId("plan-row-state")).toHaveText("整理済み");
    await expect(row.getByTestId("plan-row-warning")).toHaveCount(0);
  }
  expect(kindOne).not.toBe(kindThree);

  const labeled = book(page, labelName);
  await expect(labeled).toHaveAttribute("data-organized", "true");
  await expect(labeled).toHaveAttribute("data-output-name", labelName);
  await expect(labeled.getByTestId("plan-row-name")).toContainText(LABEL);
  await expect(labeled.getByTestId("plan-row-state")).toHaveText("整理済み");

  // ページが連番でなくても、種類番号だけは落とさない
  const rough = book(page, roughName);
  await expect(rough).toHaveAttribute("data-organized", "false");
  await expect(rough).toHaveAttribute("data-output-name", roughName);
  await expect(rough.getByTestId("plan-row-name")).toContainText("第003巻_2");
  await expect(rough.getByTestId("volume-chip")).toHaveText("第003巻");
  await expect(rough.getByTestId("plan-row-warning")).toHaveAttribute(
    "title",
    /連番と違います/,
  );
  await expect(rough.getByTestId("plan-row-warning")).not.toHaveAttribute(
    "title",
    /巻数が読めません/,
  );

  const loose = book(page, looseName);
  await expect(loose).toHaveAttribute("data-organized", "false");
  await expect(loose.getByTestId("volume-chip")).toHaveText("Unknown");
  await expect(loose.getByTestId("plan-row-warning")).toHaveAttribute(
    "title",
    /巻数が読めません/,
  );

  // CI では Playwright の出力先へ。エージェント用の場所は、書けたときだけ写す
  const shots = [
    ["kind-numbers.png", page.getByTestId("plan-list")],
    ["rough-keeps-suffix.png", rough],
    ["unnamed-still-warns.png", loose],
  ] as const;
  for (const [name, target] of shots) {
    const path = testInfo.outputPath(name);
    await target.screenshot({ path });
    try {
      mkdirSync(AGENT_SHOT_DIR, { recursive: true });
      copyFileSync(path, join(AGENT_SHOT_DIR, name));
    } catch {
      // CI やエージェント用の場所が無いときは、テストそのものは落とさない
    }
  }
});
