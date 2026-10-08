import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

test("全モードで一覧の配置と表示設定を共有し、余白カットは分割と結合の間に並ぶ", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "margin-layout.zip");
  runPython(
    `import io,sys,zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1],'w') as archive:
 for i in range(12):
  buffer=io.BytesIO(); Image.new('RGB',(1200 if i==5 else 300,900),(20+i*10,40,60)).save(buffer,'PNG'); archive.writestr(f'{i+1:03d}.png',buffer.getvalue())`,
    archive,
  );
  await page.setViewportSize({ width: 1318, height: 890 });
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  const cards = page.getByTestId("editable-page");
  await expect(cards).toHaveCount(12);
  await cards
    .nth(1)
    .getByRole("button", { name: /の操作$/ })
    .click();
  await cards
    .nth(1)
    .getByRole("menuitem", { name: "ページを削除（復元可能）", exact: true })
    .click();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("11 ページ");
  await expect(page.getByTestId("split-step-split")).toBeEnabled();
  await page.getByTestId("split-step-split").click();
  await page.getByTestId("show-deleted-pages").check();
  await page.getByTestId("page-direction").check();
  await page.getByTestId("split-card-width").fill("220");
  await expect(cards).toHaveCount(12);
  const layout = () =>
    cards.evaluateAll((elements) => {
      const grid = elements[0].closest('[data-testid="split-grid"]')!;
      const top = grid.getBoundingClientRect().top;
      return elements.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          name: element.getAttribute("data-name"),
          x: Math.round(box.x),
          y: Math.round(box.y - top + grid.scrollTop),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      });
    });
  const splitLayout = await layout();
  await page.getByTestId("split-step-trim").click();
  await expect(page.getByTestId("split-step-trim")).toBeEnabled();
  await expect(page.getByTestId("margin-card")).toHaveCount(12);
  expect(await layout()).toEqual(splitLayout);
  const modeButtons = page.locator('[data-testid^="split-step-"]');
  expect(
    await modeButtons.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-testid")),
    ),
  ).toEqual(["split-step-split", "split-step-trim", "split-step-merge"]);
  await expect(
    page
      .locator('[data-testid="editable-page"][data-deleted="true"]')
      .getByRole("checkbox"),
  ).toBeDisabled();
  await page.screenshot({
    path: test.info().outputPath("shared-margin-list.png"),
  });
  await page.getByTestId("page-direction").uncheck();
  await page.getByTestId("show-deleted-pages").uncheck();
  await page.getByTestId("split-card-width").fill("240");
  await expect(cards).toHaveCount(11);
  const trimLayout = await layout();
  for (const mode of ["split", "merge"]) {
    await page.getByTestId(`split-step-${mode}`).click();
    await expect(page.getByTestId("page-direction")).not.toBeChecked();
    await expect(page.getByTestId("show-deleted-pages")).not.toBeChecked();
    await expect(page.getByTestId("split-card-width")).toHaveValue("240");
    expect(await layout()).toEqual(trimLayout);
  }
});

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
  await expect(page.getByTestId("lightbox")).toBeVisible();
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
  await expect
    .poll(() =>
      page
        .getByTestId("margin-image")
        .first()
        .evaluate(
          (image: HTMLImageElement) => image.naturalWidth / image.naturalHeight,
        ),
    )
    .toBeCloseTo(320 / 540, 2);
  await page.screenshot({ path: test.info().outputPath("margin-editor.png") });
  await page.getByTestId("split-step-merge").click();
  await expect(page.getByTestId("merge-card")).toHaveCount(3);
  await expect(page.getByTestId("split-confirm")).toBeDisabled();
});
