import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runPython } from "./archive";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

test("余白の解析は切り替え・保存で繰り返さず、再検出時にだけ実行する", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "scan-frequency.zip");
  runPython(
    `import io,sys,zipfile
from PIL import Image,ImageDraw
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for i in range(3):
  im=Image.new('RGB',(400,600),'white'); ImageDraw.Draw(im).rectangle((40,30,359,569), fill=(30+i*30,40,60))
  b=io.BytesIO(); im.save(b,'PNG'); z.writestr(f'{i+1:03d}.png',b.getvalue())`,
    archive,
  );
  const scans: boolean[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/jobs/margin-scan" &&
      request.method() === "POST"
    )
      scans.push(request.postDataJSON().detect);
  });
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  await expect(page.getByTestId("margin-card")).toHaveCount(3);
  expect(scans).toEqual([true]);
  const before = readFileSync(archive);
  await page.getByTestId("editor-select-none").click();
  await expect(
    page.getByRole("checkbox", { name: "1 ページを切り取る", exact: true }),
  ).not.toBeChecked();
  await page.getByTestId("undo").click();
  await expect(
    page.getByRole("checkbox", { name: "1 ページを切り取る", exact: true }),
  ).toBeChecked();
  for (const mode of ["merge", "split", "trim"])
    await page.getByTestId(`split-step-${mode}`).click();
  expect(readFileSync(archive)).toEqual(before);
  expect(scans).toEqual([true]);
  await page.getByTestId("margin-save").click();
  await expect(page.getByTestId("margin-result")).toContainText(
    "画像が変わりました",
  );
  expect(scans).toEqual([true, false]);
  for (const mode of ["merge", "trim"])
    await page.getByTestId(`split-step-${mode}`).click();
  expect(scans).toEqual([true, false]);
  await page.getByRole("button", { name: "再検出", exact: true }).click();
  await expect(page.getByTestId("margin-result")).toContainText("共通余白なし");
  expect(scans).toEqual([true, false, true]);
});

test("手動ペアも全解除・全選択でき、説明はツールチップに集約する", async ({
  page,
}) => {
  const archive = writeArchive(sidecar.workDir, "manual-selection.zip", [
    { name: "001.jpg", color: "red" },
    { name: "002.jpg", color: "green" },
    { name: "003.jpg", color: "blue" },
  ]);
  const before = readFileSync(archive);
  await page.setViewportSize({ width: 1050, height: 700 });
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  await expect(page.getByTestId("margin-card")).toHaveCount(3);
  await page.getByTestId("split-step-merge").click();
  const cards = page.getByTestId("merge-card");
  await expect(cards).toHaveCount(3);
  await cards.first().getByTestId("merge-pick").click();
  await cards.nth(1).getByTestId("merge-partner").click();
  await expect(
    page.locator('[data-testid="merge-card"][data-kind="joined"]'),
  ).toHaveCount(1);
  await page.getByTestId("editor-select-none").click();
  await expect(cards).toHaveCount(3);
  await page.getByTestId("merge-all").click();
  await expect(
    page.locator('[data-testid="merge-card"][data-kind="joined"]'),
  ).toHaveCount(1);
  expect(readFileSync(archive)).toEqual(before);
  await page.getByTestId("editor-select-detected").click();
  await expect(cards).toHaveCount(3);
  await page.getByTestId("split-step-merge").hover();
  await expect(page.getByRole("tooltip")).toContainText("右上の変更を反映");
  await expect(page.getByTestId("split-confirm")).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("editor-header.png") });
});
