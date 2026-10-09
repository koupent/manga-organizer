import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { pageSizesOf, runPython } from "./archive";
import { join } from "node:path";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

async function open(page: Page, name: string, count = 8) {
  const colors = [
    "red",
    "green",
    "blue",
    "yellow",
    "purple",
    "gray",
    "pink",
    "orange",
  ];
  const archive = writeArchive(
    sidecar.workDir,
    name,
    colors.slice(0, count).map((color, i) => ({
      name: `${String(i + 1).padStart(3, "0")}.jpg`,
      color,
    })),
  );
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  await expect(page.getByTestId("margin-card")).toHaveCount(count);
  await page.getByTestId("split-step-merge").click();
  return archive;
}

async function joined(page: Page) {
  return page
    .locator(
      '[data-testid="editable-page"]:has([data-testid="merge-card"][data-kind="joined"])',
    )
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-name")),
    );
}

async function exclude(
  page: Page,
  cardName: string,
  target: string,
  restore = false,
) {
  await page
    .locator(
      `[data-testid="editable-page"][data-name="${cardName}"] [role="group"]`,
    )
    .click({ button: "right" });
  await page
    .getByRole("menuitem", {
      name: `${target} を結合対象${restore ? "に戻す" : "から除外"}`,
      exact: true,
    })
    .click();
}

test("全選択は表紙を残して全ページを順にペア化し、途中の除外・復帰で組み直す", async ({
  page,
}) => {
  const archive = await open(page, "pair-all.zip");
  const before = readFileSync(archive);
  await expect(page.getByTestId("merge-selection-hint")).toBeInViewport();
  await page.getByTestId("editor-select-detected").click();
  expect(await joined(page)).toEqual([]);
  await page.getByTestId("merge-all").click();
  expect(await joined(page)).toEqual(["002.jpg", "004.jpg", "006.jpg"]);
  await expect(
    page.locator('[data-testid="editable-page"][data-cover="true"]'),
  ).toHaveAttribute("data-name", "001.jpg");
  await exclude(page, "004.jpg", "004.jpg");
  expect(await joined(page)).toEqual(["002.jpg", "005.jpg", "007.jpg"]);
  const excluded = page.locator(
    '[data-testid="editable-page"][data-name="004.jpg"]',
  );
  await expect(excluded).toHaveAttribute("data-merge-excluded", "true");
  await expect(excluded).toContainText("結合対象外");
  await page.getByTestId("undo").click();
  expect(await joined(page)).toEqual(["002.jpg", "004.jpg", "006.jpg"]);
  await exclude(page, "004.jpg", "004.jpg");
  await exclude(page, "004.jpg", "004.jpg", true);
  expect(await joined(page)).toEqual(["002.jpg", "004.jpg", "006.jpg"]);
  await exclude(page, "002.jpg", "003.jpg");
  expect(await joined(page)).toEqual(["004.jpg", "006.jpg"]);
  await exclude(page, "003.jpg", "003.jpg", true);
  await exclude(page, "004.jpg", "004.jpg");
  expect(readFileSync(archive)).toEqual(before);
  await page.screenshot({
    path: test.info().outputPath("merge-all-exclusion.png"),
  });
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("5 ページ");
  await expect(page.getByTestId("split-confirm")).toBeDisabled();
  expect(Object.values(pageSizesOf(archive))).toEqual([
    [600, 900],
    [1200, 900],
    [600, 900],
    [1200, 900],
    [1200, 900],
  ]);
});

test("全選択の前の除外も維持し、全解除と自動検出分では勝手にペアを作らない", async ({
  page,
}) => {
  await open(page, "exclude-first.zip", 7);
  await page.getByTestId("page-direction").check();
  await exclude(page, "004.jpg", "004.jpg");
  await page.getByTestId("merge-all").click();
  expect(await joined(page)).toEqual(["002.jpg", "005.jpg"]);
  await page.getByTestId("editor-select-none").click();
  expect(await joined(page)).toEqual([]);
  await page.getByTestId("editor-select-detected").click();
  expect(await joined(page)).toEqual([]);
  await page.getByTestId("merge-all").click();
  expect(await joined(page)).toEqual(["002.jpg", "005.jpg"]);
});

test("横長のページも全選択で隣と結合でき、保存済みの分割対もページ単位で扱う", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "wide-and-split.zip");
  runPython(
    `import io,sys,zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 for i,w in enumerate([600,1200,600,1200]):
  b=io.BytesIO(); Image.new('RGB',(w,900),(40+i*40,60,70)).save(b,'PNG'); z.writestr(f'{i+1:03d}.png',b.getvalue())`,
    archive,
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  await expect(page.getByTestId("margin-card")).toHaveCount(4);
  await page.getByTestId("split-step-merge").click();
  await page.getByTestId("merge-all").click();
  expect(await joined(page)).toEqual(["002.png"]);
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("3 ページ");
  await expect(page.getByTestId("split-confirm")).toBeDisabled();
  expect(Object.values(pageSizesOf(archive))).toEqual([
    [600, 900],
    [1800, 900],
    [1200, 900],
  ]);
  await page.getByTestId("split-step-split").click();
  await page.getByTestId("split-all").click();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-confirm")).toBeDisabled();
  await expect(page.getByTestId("split-page-count")).toHaveText("5 ページ");
  await page.getByTestId("split-step-merge").click();
  await page.getByTestId("merge-all").click();
  expect(await joined(page)).toHaveLength(2);
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("3 ページ");
  await expect(page.getByTestId("split-confirm")).toBeDisabled();
  expect(Object.values(pageSizesOf(archive))).toEqual([
    [600, 900],
    [1800, 900],
    [1200, 900],
  ]);
});
