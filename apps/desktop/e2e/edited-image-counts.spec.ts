import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";
import { pageEntriesOf, runPython } from "./archive";
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());
for (const kind of ["input", "existing", "produced"]) {
  test(`編集保存後の枚数を更新し、復元後も一致する: ${kind}`, async ({
    page,
  }) => {
    const root = join(sidecar.workDir, kind);
    mkdirSync(root);
    const output = join(root, "out");
    mkdirSync(output);
    mkdirSync(join(root, "shelf"));
    const series = "[著者] 作品";
    const folder = join(output, series);
    mkdirSync(folder);
    let archive = writeArchive(
      root,
      kind === "input"
        ? join("shelf", `${series} 第001巻.zip`)
        : kind === "existing"
          ? join("out", series, `${series} 第001巻.zip`)
          : "source_01.zip",
      ["red", "green", "blue"].map((color, i) => ({
        name: `00${i + 1}.jpg`,
        color,
      })),
    );
    if (kind === "existing")
      writeArchive(root, "source_02.zip", [{ name: "001.jpg", color: "red" }]);
    await page.route("**/api/library/suggest*", (route) =>
      route.fulfill({ json: { author: null, candidates: [] } }),
    );
    await page.goto(
      `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "organize", output })}`,
    );
    await page.getByTestId("organize-title").fill("作品");
    await page.getByTestId("organize-author").fill("著者");
    await page.getByTestId("open-browser").click();
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${kind}"] .browser-name`,
      )
      .click();
    if (kind === "input") {
      await page
        .locator('[data-testid="browse-entry"][data-name="shelf"]')
        .getByRole("button", { name: "フォルダごと追加" })
        .click();
      await page.getByTestId("browse-close").click();
    } else {
      await page
        .locator(
          `[data-testid="browse-entry"][data-name="source_0${kind === "existing" ? "2" : "1"}.zip"] .browser-name`,
        )
        .click();
      await page.getByTestId("open-browser").click();
    }
    const row = page
      .locator('[data-testid="plan-row"][data-kind="book"]')
      .filter({
        has: page
          .getByTestId("plan-row-name")
          .filter({ hasText: "第001巻.zip" }),
      });
    await expect(row).toHaveCount(1);
    if (kind === "produced") {
      await page.getByTestId("confirm").click();
      await expect(page.getByTestId("organize-status")).toContainText(
        "整理しました",
      );
      archive = join(folder, `${series} 第001巻.zip`);
    }
    await row.getByTestId("plan-to-edit").click();
    await page.getByTestId("split-step-split").click();
    const cards = page.getByTestId("editable-page");
    await expect(cards).toHaveCount(3);
    await cards
      .nth(1)
      .getByRole("button", { name: /の操作$/ })
      .click();
    await cards
      .nth(1)
      .getByRole("menuitem", { name: "ページを削除（復元可能）", exact: true })
      .click();
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-page-count")).toHaveText("2 ページ");
    expect(pageEntriesOf(archive)).toHaveLength(2);
    await page.getByTestId("mode-organize").click();
    await expect(row.getByTestId("plan-row-image-count")).toHaveText("2枚");

    await row.getByTestId("plan-reset").click();
    await page.getByTestId("edit-reset-confirm").click();
    await expect(page.getByTestId("edit-reset-dialog")).toHaveCount(0);
    expect(pageEntriesOf(archive)).toHaveLength(3);
    await expect(
      page.locator('[data-testid="plan-row"][data-kind="book"]').filter({
        has: page
          .getByTestId("plan-row-image-count")
          .filter({ hasText: "3枚" }),
      }),
    ).toHaveCount(1);
  });
}

test("今回作った本の分割・結合・復元では元入力でなく出力ZIPの枚数を表示する", async ({
  page,
}) => {
  const output = join(sidecar.workDir, "split-merge-output");
  mkdirSync(output);
  const source = join(sidecar.workDir, "changes_01.zip");
  runPython(
    `
import io,sys,zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    for index,(width,colour) in enumerate([(600,'red'),(1200,'green'),(600,'blue')],1):
        data=io.BytesIO()
        Image.new('RGB',(width,900),colour).save(data,'PNG')
        archive.writestr(f'{index:03d}.png', data.getvalue())
`,
    source,
  );
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({ json: { author: null, candidates: [] } }),
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "organize", output })}`,
  );
  await page.getByTestId("organize-title").fill("作品");
  await page.getByTestId("organize-author").fill("著者");
  await page.getByTestId("open-browser").click();
  await page
    .locator(
      '[data-testid="browse-entry"][data-name="changes_01.zip"] .browser-name',
    )
    .click();
  await page.getByTestId("open-browser").click();
  const row = page.locator('[data-testid="plan-row"][data-kind="book"]');
  await expect(row.getByTestId("plan-row-image-count")).toHaveText("3枚");
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("organize-status")).toContainText(
    "整理しました",
  );
  const archive = join(output, "[著者] 作品", "[著者] 作品 第001巻.zip");
  await row.getByTestId("plan-to-edit").click();
  await page.getByTestId("split-step-split").click();
  await page.getByTestId("split-all").click();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("4 ページ");
  expect(pageEntriesOf(archive)).toHaveLength(4);
  expect(pageEntriesOf(source)).toHaveLength(3);
  await page.getByTestId("mode-organize").click();
  await expect(row.getByTestId("plan-row-image-count")).toHaveText("4枚");
  await row.getByTestId("plan-to-edit").click();
  await page.getByTestId("split-step-merge").click();
  await page.getByTestId("merge-all").click();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("3 ページ");
  expect(pageEntriesOf(archive)).toHaveLength(3);
  await page.getByTestId("mode-organize").click();
  await expect(row.getByTestId("plan-row-image-count")).toHaveText("3枚");
  await row.getByTestId("plan-reset").click();
  await page.getByTestId("edit-reset-confirm").click();
  await expect(page.getByTestId("edit-reset-dialog")).toHaveCount(0);
  expect(pageEntriesOf(archive)).toHaveLength(3);
  await expect(row.getByTestId("plan-row-image-count")).toHaveText("3枚");
});

test("枚数取得中に同巻の番号が詰まっても、改名先の最新枚数を表示する", async ({
  page,
}) => {
  const output = join(sidecar.workDir, "delayed-output");
  const series = "[著者] 作品";
  const folder = join(output, series);
  mkdirSync(folder, { recursive: true });
  const plain = writeArchive(
    sidecar.workDir,
    join("delayed-output", series, `${series} 第001巻.zip`),
    [{ name: "001.jpg", color: "black" }],
  );
  const source = writeArchive(
    sidecar.workDir,
    "delayed_01.zip",
    ["red", "green", "blue"].map((color, i) => ({
      name: `00${i + 1}.jpg`,
      color,
    })),
  );
  const numbered = join(folder, `${series} 第001巻_1.zip`);
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({ json: { author: null, candidates: [] } }),
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "organize", output })}`,
  );
  await page.getByTestId("organize-title").fill("作品");
  await page.getByTestId("organize-author").fill("著者");
  await page.getByTestId("open-browser").click();
  await page
    .locator(
      '[data-testid="browse-entry"][data-name="delayed_01.zip"] .browser-name',
    )
    .click();
  await page.getByTestId("open-browser").click();
  const input = page.locator(
    '[data-testid="plan-row"][data-kind="book"]:not([data-existing])',
  );
  await expect(input.getByTestId("plan-check")).not.toBeChecked();
  await input.getByTestId("plan-check").click();
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("organize-status")).toContainText(
    "整理しました",
  );
  await input.getByTestId("plan-to-edit").click();
  await page.getByTestId("split-step-split").click();
  const cards = page.getByTestId("editable-page");
  await expect(cards).toHaveCount(3);
  await cards
    .nth(1)
    .getByRole("button", { name: /の操作$/ })
    .click();
  await cards
    .nth(1)
    .getByRole("menuitem", { name: "ページを削除（復元可能）", exact: true })
    .click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const ready = new Promise<void>((resolve) => {
    received = resolve;
  });
  let fulfilled!: () => void;
  const done = new Promise<void>((resolve) => {
    fulfilled = resolve;
  });
  await page.route("**/api/pages?*", async (route) => {
    const response = await route.fetch();
    if (
      new URL(route.request().url()).searchParams.get("archive") === numbered
    ) {
      received();
      await held;
      await route.fulfill({ response });
      fulfilled();
    } else await route.fulfill({ response });
  });
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("2 ページ");
  await ready;
  expect(pageEntriesOf(numbered)).toHaveLength(2);
  await page.getByTestId("mode-organize").click();
  await page
    .locator('[data-testid="plan-row"][data-existing]')
    .getByTestId("plan-trash")
    .click();
  await page.getByTestId("trash-confirm").click();
  await expect(input).toHaveAttribute("data-made", plain);
  await expect(input.getByTestId("plan-row-image-count")).toHaveText("2枚");
  release();
  await done;
  await expect(input.getByTestId("plan-row-image-count")).toHaveText("2枚");
  expect(pageEntriesOf(plain)).toHaveLength(2);
  expect(pageEntriesOf(source)).toHaveLength(3);
});
