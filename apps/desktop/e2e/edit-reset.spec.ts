import { expect, test } from "@playwright/test";
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { runPython } from "./archive";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

test("編集ボタン右隣から全編集を戻し、確認済みの印と開いていた編集画面を更新する", async ({
  page,
}) => {
  const archive = writeArchive(sidecar.workDir, "[著者] リセット 第001巻.zip", [
    { name: "001.jpg", color: "#112233" },
    { name: "002.jpg", color: "#445566" },
  ]);
  const before = readFileSync(archive);
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({ json: { author: null, candidates: [] } }),
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "organize", output: sidecar.workDir })}`,
  );
  await page.getByTestId("open-browser").click();
  await page
    .locator(
      `[data-testid="browse-entry"][data-name="${basename(archive)}"] .browser-name`,
    )
    .click();
  await page.getByTestId("browse-close").click();
  const reset = page.getByTestId("plan-reset");
  await expect(reset).toBeDisabled();
  const edit = page.getByTestId("plan-to-edit");
  expect((await reset.boundingBox())!.x).toBeGreaterThan(
    (await edit.boundingBox())!.x,
  );
  await edit.click();
  await expect(page.getByTestId("split-step-trim")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("split-step-split").click();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-confirm")).toBeDisabled();
  await expect.poll(() => readFileSync(archive).equals(before)).toBe(false);
  await page.getByTestId("mode-organize").click();
  await expect(reset).toBeEnabled();
  await reset.click();
  await page.getByRole("button", { name: "やめる", exact: true }).click();
  await expect(reset).toBeEnabled();
  await reset.click();
  await page.getByTestId("edit-reset-confirm").click();
  await expect(page.getByTestId("edit-reset-dialog")).toBeHidden();
  await expect(reset).toBeDisabled();
  expect(readFileSync(archive)).toEqual(before);
  await expect(edit).toHaveAttribute("data-edited", "false");
  await page.screenshot({ path: test.info().outputPath("reset-action.png") });
  await edit.click();
  await expect(page.getByTestId("split-step-trim")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("split-step-split").click();
  await expect(page.getByTestId("split-confirm")).toHaveText("確認済みにする");
  await expect(page.getByTestId("split-confirm")).toBeEnabled();
});

test("旧版の編集を完全に戻せない場合は理由を表示し、ファイルを変更しない", async ({
  page,
}) => {
  const archive = writeArchive(sidecar.workDir, "[著者] 旧版 第001巻.zip", [
    { name: "001.jpg", color: "#112233" },
  ]);
  runPython(
    "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'a') as z: z.writestr('.manga-organizer/manifest.json',json.dumps({'version':1,'edits':['reorder']}))",
    archive,
  );
  const before = readFileSync(archive);
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({ json: { author: null, candidates: [] } }),
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "organize", output: sidecar.workDir })}`,
  );
  await page.getByTestId("open-browser").click();
  await page
    .locator(
      `[data-testid="browse-entry"][data-name="${basename(archive)}"] .browser-name`,
    )
    .click();
  await page.getByTestId("browse-close").click();
  await page.getByTestId("plan-reset").click();
  await page.getByTestId("edit-reset-confirm").click();
  await expect(page.getByRole("alert")).toContainText("旧版で編集した本");
  expect(readFileSync(archive)).toEqual(before);
  await page.getByRole("button", { name: "やめる", exact: true }).click();
  await expect(page.getByTestId("plan-reset")).toBeEnabled();
});
