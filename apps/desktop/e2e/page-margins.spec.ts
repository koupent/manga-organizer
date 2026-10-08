import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

test("共通余白を提案し、選んだページだけ同じ範囲で切り取って保存する", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "margin-book.zip");
  runPython(
    `import io,sys,zipfile
from PIL import Image,ImageDraw
with zipfile.ZipFile(sys.argv[1],'w') as archive:
 for i in range(3):
  image=Image.new('RGB',(400,600),'white')
  ImageDraw.Draw(image).rectangle((40,30,359,569),fill='black')
  buffer=io.BytesIO(); image.save(buffer,'PNG'); archive.writestr(f'{i+1:03d}.png',buffer.getvalue())`,
    archive,
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  await page.getByTestId("split-step-trim").click();
  await expect(page.getByTestId("margin-card")).toHaveCount(3);
  await page
    .getByRole("button", { name: "1 ページを大きく表示", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "切り取り範囲の確認" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("margin-0")).not.toHaveValue("0");
  await page.getByTestId("margin-0").fill("10");
  await page.getByTestId("margin-1").fill("5");
  await page.getByTestId("margin-2").fill("10");
  await page.getByTestId("margin-3").fill("5");
  await page
    .getByRole("checkbox", { name: "2 ページを切り取る", exact: true })
    .click();
  await page.getByTestId("split-step-merge").click();
  await page.getByTestId("split-step-trim").click();
  await expect(page.getByTestId("margin-0")).toHaveValue("10");
  await expect(
    page.getByRole("checkbox", { name: "2 ページを切り取る", exact: true }),
  ).not.toBeChecked();
  await page.getByTestId("margin-save").click();
  await expect
    .poll(() => Object.values(pageSizesOf(archive)))
    .toEqual([
      [320, 540],
      [400, 600],
      [320, 540],
    ]);
  await expect(page.getByTestId("margin-card")).toHaveCount(3);
  await expect(page.getByTestId("split-step-merge")).toBeEnabled();
  await expect(page.getByTestId("margin-card").first()).toContainText(
    "320 × 540",
  );
  await page.screenshot({ path: test.info().outputPath("margin-editor.png") });
  await page.getByTestId("split-step-merge").click();
  await expect(page.getByTestId("merge-card")).toHaveCount(3);
  await expect(page.getByTestId("split-confirm")).toBeDisabled();
});
