import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startSidecar, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
  for (const name of ["保存先", "投入元"]) {
    mkdirSync(join(sidecar.workDir, name));
  }
});
test.afterAll(() => sidecar?.stop());

test("参照でパスを入力でき、設定したデフォルト出力先が投入後と再起動後も残る", async ({
  page,
}) => {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}&mode=organize`,
  );
  await page.getByTestId("browse-output").click();
  const browser = page.getByTestId("output-browser");
  const destination = join(sidecar.workDir, "保存先");
  const address = browser.getByTestId("output-browser-path");
  await address.fill(destination);
  await address.press("Enter");
  await expect(browser.getByTestId("use-this-directory")).toBeEnabled();
  await browser.getByTestId("use-this-directory").click();
  await expect(page.getByTestId("output-directory")).toHaveValue(destination);

  await page.getByTestId("browse-output").click();
  await browser.getByTestId("output-default-settings").click();
  const settings = page.getByTestId("settings-dialog");
  await expect(settings).toBeVisible();
  await settings.getByTestId("output-directory").fill(destination);
  await page.getByRole("button", { name: "設定を閉じる" }).click();
  await page.getByTestId("open-browser").click();
  await page
    .locator('[data-testid="browse-entry"][data-name="投入元"]')
    .getByRole("button", { name: "フォルダごと追加" })
    .click();
  await page.getByTestId("browse-close").click();
  await expect(page.getByTestId("output-directory")).toHaveValue(destination);
  await page.reload();
  await expect(page.getByTestId("output-directory")).toHaveValue(destination);

  await page.getByTestId("browse-output").click();
  await address.fill(join(sidecar.workDir, "存在しない場所"));
  await address.press("Enter");
  await expect(browser.getByRole("alert")).toBeVisible();
  await expect(browser.getByTestId("use-this-directory")).toBeDisabled();
});
