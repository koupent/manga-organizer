import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * 巻スロットが巻数ではない名前（``エイジ``）を、整理済みのまま読む。
 *
 * ``[著者] 作品 第001巻.zip`` は整理済みになる。同じ規則でスロットだけが
 * 巻数ではない本を入れ直すと、``Unknown`` と「巻数が読めません」になっていた。
 * まだその名前でない本は、巻の札へ 1 語を入れると、その名前で出て、
 * もう一度入れると整理済みになる。``loose.zip`` のような名前は警告のまま。
 */

const AUTHOR = "金城宗幸";
const TITLE = "ブルーロック";
const LABEL = "エイジ";
const FOLDER = "蔵書";

const labelName = `[${AUTHOR}] ${TITLE} ${LABEL}.zip`;
const volumeName = `[${AUTHOR}] ${TITLE} 第001巻.zip`;
const looseName = "loose.zip";

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
  mkdirSync(join(sidecar.workDir, FOLDER), { recursive: true });
  const pages = [
    { name: "001.jpg", color: "#336699" },
    { name: "002.jpg", color: "#993333" },
  ];
  writeArchive(sidecar.workDir, `${FOLDER}/${labelName}`, pages);
  writeArchive(sidecar.workDir, `${FOLDER}/${volumeName}`, pages);
  writeArchive(sidecar.workDir, `${FOLDER}/${looseName}`, [
    { name: "001.jpg", color: "#666666" },
  ]);
});

test.afterAll(() => sidecar?.stop());

async function openOrganize(page: Page, output: string, named: boolean) {
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width: 1400, height: 900 });
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
  if (named) {
    await page.getByTestId("organize-title").fill(TITLE);
    await page.getByTestId("organize-author").fill(AUTHOR);
  }
}

async function addFolder(page: Page) {
  await page.getByTestId("open-browser").click();
  await page
    .locator(`[data-testid="browse-entry"][data-name="${FOLDER}"]`)
    .getByRole("button", { name: "フォルダごと追加" })
    .click();
  await page.getByTestId("browse-close").click();
}

function book(page: Page, fileName: string) {
  return page.locator(
    `[data-testid="plan-row"][data-kind="book"][data-source=${JSON.stringify(
      join(sidecar.workDir, FOLDER, fileName),
    )}]`,
  );
}

async function waitForBooks(page: Page, count: number) {
  await expect(
    page.locator('[data-testid="plan-row"][data-kind="book"]'),
  ).toHaveCount(count, { timeout: 30_000 });
}

test("入れ直したラベルの本は本当の名前で整理済み、第001巻は変わらず、無名の本は警告のまま", async ({
  page,
}) => {
  // Arrange - 著者欄は空のまま。報告では、名前を持たない本だけが Unknown になる
  await openOrganize(page, join(sidecar.workDir, "out-recognize"), false);
  await addFolder(page);
  await waitForBooks(page, 3);

  // Assert - 巻数ではないスロットは、Unknown にせず本当の名前で整理済み
  const labeled = book(page, labelName);
  await expect(labeled).toHaveAttribute("data-organized", "true");
  await expect(labeled).toHaveAttribute("data-output-name", labelName);
  await expect(labeled.getByTestId("plan-row-state")).toHaveText("整理済み");
  await expect(labeled.getByTestId("plan-row-warning")).toHaveCount(0);

  // Assert - 第001巻 は今までどおり
  const volume = book(page, volumeName);
  await expect(volume).toHaveAttribute("data-organized", "true");
  await expect(volume).toHaveAttribute("data-output-name", volumeName);
  await expect(volume.getByTestId("plan-row-state")).toHaveText("整理済み");

  // Assert - 規則に合わない名前は、巻数が読めない警告のまま
  const loose = book(page, looseName);
  await expect(loose).toHaveAttribute("data-organized", "false");
  await expect(loose).toHaveAttribute("data-output-name", "[]  Unknown.zip");
  await expect(loose.getByTestId("plan-row-warning")).toHaveAttribute(
    "title",
    /巻数が読めません/,
  );
});

test("巻の札へラベルを入れると、その名前で出て、入れ直すと整理済みになる", async ({
  page,
}) => {
  const output = join(sidecar.workDir, "out-label");
  await openOrganize(page, output, true);
  await page.getByTestId("open-browser").click();
  await page
    .locator(
      `[data-testid="browse-entry"][data-name="${FOLDER}"] .browser-name`,
    )
    .click();
  await page
    .locator(
      `[data-testid="browse-entry"][data-name="${looseName}"] .browser-name`,
    )
    .click();
  await page.getByTestId("browse-close").click();
  await waitForBooks(page, 1);
  await expect(page.getByTestId("confirm")).toBeEnabled({ timeout: 30_000 });

  const loose = book(page, looseName);
  await expect(loose.getByTestId("plan-row-warning")).toHaveAttribute(
    "title",
    /巻数が読めません/,
  );

  // Act - 巻スロットへ、巻数ではない 1 語を入れる
  await loose.getByTestId("volume-chip").click();
  await loose.getByTestId("volume-input").fill(LABEL);
  await page.keyboard.press("Enter");

  // Assert - Unknown ではなく、規則どおりの名前になる
  await expect(loose).toHaveAttribute("data-output-name", labelName);
  await expect(loose.getByTestId("volume-chip")).toHaveText(LABEL);
  await expect(
    loose.locator(
      '[data-testid="plan-row-warning"][title*="巻数が読めません"]',
    ),
  ).toHaveCount(0);

  // Act - その名前で作る
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("organize-status")).toContainText(
    "整理しました",
    {
      timeout: 60_000,
    },
  );

  // Assert - 出来た行は整理済みで、ディスク上の名前もラベル
  await expect(loose.getByTestId("plan-row-state")).toHaveText("整理済み");
  await expect(loose).toHaveAttribute("data-output-name", labelName);
  const series = join(output, `[${AUTHOR}] ${TITLE}`);
  expect(readdirSync(series)).toContain(labelName);

  // Act - 出来たファイルだけを、別の画面でもう一度入れる
  const again = await page.context().newPage();
  await openOrganize(again, join(sidecar.workDir, "out-redrop"), false);
  await again.getByTestId("open-browser").click();
  await again
    .locator(
      '[data-testid="browse-entry"][data-name="out-label"] .browser-name',
    )
    .click();
  await again
    .locator("[data-testid=browse-entry]")
    .filter({ hasText: `[${AUTHOR}] ${TITLE}` })
    .locator(".browser-name")
    .click();
  await again
    .locator("[data-testid=browse-entry]")
    .filter({ hasText: labelName })
    .locator(".browser-name")
    .click();
  await again.getByTestId("browse-close").click();
  await waitForBooks(again, 1);

  // Assert - 入れ直しても本当の名前で整理済み
  const redropped = again.locator('[data-testid="plan-row"][data-kind="book"]');
  await expect(redropped).toHaveAttribute("data-organized", "true");
  await expect(redropped).toHaveAttribute("data-output-name", labelName);
  await expect(redropped.getByTestId("plan-row-state")).toHaveText("整理済み");
  await expect(redropped.getByTestId("plan-row-warning")).toHaveCount(0);
  await again.close();
});
