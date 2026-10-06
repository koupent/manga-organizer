import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
  for (const [name, count] of [
    ["第1巻.zip", 2],
    ["第2巻.zip", 3],
    ["別版_第1巻.zip", 6],
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
  appendFileSync(join(sidecar.workDir, "第1巻.zip"), Buffer.alloc(32000, "x"));
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

test("前の投入をすべて外すと作品名と著者名が消え、同じ作品への追加投入では維持する", async ({
  page,
}) => {
  await open(page);
  await add(page, "第1巻.zip");
  await add(page, "第2巻.zip");
  await expect(page.getByTestId("organize-title")).toHaveValue("作品");
  await expect(page.getByTestId("organize-author")).toHaveValue("著者");
  await page.getByTestId("source-remove").first().click();
  await expect(page.getByTestId("organize-title")).toHaveValue("作品");
  await page.getByTestId("source-remove").click();
  await expect(page.getByTestId("organize-title")).toHaveValue("");
  await expect(page.getByTestId("organize-author")).toHaveValue("");
  await add(page, "第3巻", true);
  await expect(page.getByTestId("organize-title")).toHaveValue("");
  await expect(page.getByTestId("organize-author")).toHaveValue("");
});

test("見出しと列幅調整、画像枚数最多・下限の選択を全画面で使える", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  await add(page, "第1巻.zip");
  await add(page, "別版_第1巻.zip");
  const small = book(page, "第1巻.zip");
  const large = book(page, "別版_第1巻.zip");
  await expect(large.getByTestId("plan-row-image-count")).toHaveText("6枚");
  await expect(large.getByTestId("plan-check")).toHaveAttribute(
    "data-state",
    "checked",
  );
  await expect(small.getByTestId("plan-check")).toHaveAttribute(
    "data-state",
    "unchecked",
  );
  const header = page.getByTestId("plan-table-header");
  for (const label of [
    "元のパス",
    "変換後のファイル名",
    "画像枚数",
    "状態",
    "操作",
  ])
    await expect(
      header.getByRole("columnheader", { name: label, exact: true }),
    ).toBeVisible();
  const nameBox = (await large.getByTestId("plan-row-name").boundingBox())!;
  const countBox = (await large
    .getByTestId("plan-row-image-count")
    .boundingBox())!;
  expect(countBox.x - nameBox.x - nameBox.width).toBeLessThanOrEqual(16);
  expect(nameBox.width).toBeLessThan(400);
  const pathBefore = (await large.getByTestId("plan-row-path").boundingBox())!
    .width;
  const handle = (await page.getByTestId("resize-source").boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 80,
    handle.y + handle.height / 2,
  );
  await page.mouse.up();
  expect((await large.getByTestId("plan-row-path").boundingBox())!.width).toBe(
    pathBefore + 80,
  );
  await page.getByTestId("resize-name").focus();
  await page.keyboard.press("ArrowRight");
  expect((await large.getByTestId("plan-row-name").boundingBox())!.width).toBe(
    nameBox.width + 20,
  );
  await page.getByTestId("plan-most-images").click();
  await expect(small.getByTestId("plan-check")).toHaveAttribute(
    "data-state",
    "checked",
  );
  await page.getByTestId("plan-image-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.getByTestId("minimum-image-count").fill("3");
  await page.getByRole("button", { name: "設定を閉じる" }).click();
  await page.getByTestId("plan-minimum-only").click();
  await expect(small.getByTestId("plan-check")).toHaveAttribute(
    "data-state",
    "unchecked",
  );
  await expect(large.getByTestId("plan-check")).toHaveAttribute(
    "data-state",
    "checked",
  );
  await page.getByTestId("plan-minimum-only").click();
  await expect(small.getByTestId("plan-check")).toHaveAttribute(
    "data-state",
    "checked",
  );
  await page.getByTestId("plan-most-images").click();
  await expect(small.getByTestId("plan-check")).toHaveAttribute(
    "data-state",
    "unchecked",
  );
  await expect(page.getByTestId("plan-row-size")).toHaveCount(0);
});
