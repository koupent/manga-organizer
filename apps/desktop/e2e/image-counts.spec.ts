import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
  for (const [name, count] of [
    ["第1巻.zip", 2],
    ["第2巻.zip", 3],
  ] as const) {
    writeArchive(
      sidecar.workDir,
      name,
      Array.from({ length: count }, (_, index) => ({
        name: `${index + 1}.jpg`,
        color: "navy",
      })),
    );
  }
  const folder = join(sidecar.workDir, "第3巻");
  mkdirSync(folder);
  writeFileSync(join(folder, "001.jpg"), "fixture");
});
test.afterAll(() => sidecar?.stop());

async function open(page: Page) {
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({ json: { author: null, candidates: [] } }),
  );
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}&mode=organize`,
  );
  await page.getByTestId("organize-title").fill("作品");
  await page.getByTestId("organize-author").fill("著者");
}

async function add(page: Page, name: string, folder = false) {
  await page.getByTestId("open-browser").click();
  const entry = page.locator(
    `[data-testid="browse-entry"][data-name="${name}"]`,
  );
  if (folder)
    await entry.getByRole("button", { name: "フォルダごと追加" }).click();
  else await entry.locator(".browser-name").click();
  await page.getByTestId("browse-close").click();
}

function book(page: Page, name: string) {
  return page.locator(
    `[data-testid="plan-row"][data-kind="book"][data-source=${JSON.stringify(join(sidecar.workDir, name))}]`,
  );
}

test("画像枚数を表示し、下限未満を自動除外する。手動選択と設定保存もできる", async ({
  page,
}) => {
  await open(page);
  await add(page, "第1巻.zip");
  await add(page, "第2巻.zip");
  await add(page, "第3巻", true);
  await expect(
    book(page, "第1巻.zip").getByTestId("plan-row-image-count"),
  ).toHaveText("2枚");
  await expect(
    book(page, "第2巻.zip").getByTestId("plan-row-image-count"),
  ).toHaveText("3枚");
  await expect(
    book(page, "第3巻").getByTestId("plan-row-image-count"),
  ).toHaveText("1枚");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("minimum-image-count").fill("3");
  await page.getByRole("button", { name: "設定を閉じる" }).click();
  await expect(
    book(page, "第1巻.zip").getByTestId("plan-check"),
  ).toHaveAttribute("data-state", "unchecked");
  await expect(
    book(page, "第2巻.zip").getByTestId("plan-check"),
  ).toHaveAttribute("data-state", "checked");
  await expect(book(page, "第3巻").getByTestId("plan-check")).toHaveAttribute(
    "data-state",
    "unchecked",
  );
  await book(page, "第1巻.zip").getByTestId("plan-check").click();
  await expect(
    book(page, "第1巻.zip").getByTestId("plan-check"),
  ).toHaveAttribute("data-state", "checked");
  await page.reload();
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("minimum-image-count")).toHaveValue("3");
  await page.getByTestId("minimum-image-count").fill("0");
  await page.getByRole("button", { name: "設定を閉じる" }).click();
  await add(page, "第1巻.zip");
  await expect(
    book(page, "第1巻.zip").getByTestId("plan-check"),
  ).toHaveAttribute("data-state", "checked");
});

test("入力を外して再投入したとき、前の巻数訂正とチェックを持ち越さない", async ({
  page,
}) => {
  await open(page);
  await add(page, "第1巻.zip");
  const first = book(page, "第1巻.zip");
  await first.getByTestId("volume-chip").click();
  await first.getByTestId("volume-input").fill("99");
  await first.getByTestId("volume-input").press("Enter");
  await first.getByTestId("plan-check").click();
  await page.getByTestId("source-remove").click();
  await add(page, "第2巻.zip");
  await add(page, "第1巻.zip");
  await expect(first.getByTestId("volume-chip")).toHaveText("第001巻");
  await expect(first.getByTestId("plan-check")).toHaveAttribute(
    "data-state",
    "checked",
  );
  await expect(book(page, "第2巻.zip").getByTestId("volume-chip")).toHaveText(
    "第002巻",
  );
});
