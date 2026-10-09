import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

test("全モードで一覧の配置と表示設定を共有し、余白カットが先頭・初期モードになる", async ({
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
  await expect(page.getByTestId("split-step-trim")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("margin-card")).toHaveCount(12);
  await page.getByTestId("split-step-split").click();
  const cards = page.getByTestId("editable-page");
  await expect(cards).toHaveCount(12);
  await page.getByTestId("editor-select-none").click();
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
  const gridTop = (await page.getByTestId("split-grid").boundingBox())!.y;
  await page.getByTestId("split-step-trim").click();
  await expect(page.getByTestId("split-step-trim")).toBeEnabled();
  await expect(page.getByTestId("margin-card")).toHaveCount(12);
  await expect(page.getByTestId("margin-result")).toContainText("共通余白なし");
  await expect(page.getByTestId("margin-result")).toContainText("指定できます");
  await expect(page.getByTestId("margin-save")).toBeDisabled();
  expect(await layout()).toEqual(splitLayout);
  expect((await page.getByTestId("split-grid").boundingBox())!.y).toBe(gridTop);
  await page.getByTestId("margin-settings").click();
  await expect(page.getByTestId("margin-settings-dialog")).toBeVisible();
  expect((await page.getByTestId("split-grid").boundingBox())!.y).toBe(gridTop);
  await page
    .getByRole("button", { name: "範囲を一覧で確認", exact: true })
    .click();
  expect((await page.getByTestId("split-grid").boundingBox())!.y).toBe(gridTop);
  const modeButtons = page.locator('[data-testid^="split-step-"]');
  expect(
    await modeButtons.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-testid")),
    ),
  ).toEqual(["split-step-trim", "split-step-split", "split-step-merge"]);
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
  await page.getByTestId("margin-settings").click();
  await expect(page.getByTestId("margin-0")).not.toHaveValue("0");
  await page.getByTestId("margin-0").fill("10");
  await page.getByTestId("margin-1").fill("5");
  await page.getByTestId("margin-2").fill("10");
  await page.getByTestId("margin-3").fill("5");
  await page
    .getByRole("button", { name: "範囲を一覧で確認", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "2 ページを切り取る", exact: true })
    .click();
  await page.getByTestId("split-step-merge").click();
  await page.getByTestId("split-step-trim").click();
  await page.getByTestId("margin-settings").click();
  await expect(page.getByTestId("margin-0")).toHaveValue("10");
  await page
    .getByRole("button", { name: "範囲を一覧で確認", exact: true })
    .click();
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
  // 保存済みの加工は選択解除と分け、ヘッダーの共通復元操作から戻す。
  await page.reload();
  await expect(page.getByTestId("margin-card")).toHaveCount(3);
  await page
    .getByRole("combobox", { name: "保存済み編集の復元" })
    .selectOption("trim");
  await expect(page.getByTestId("edit-reset-dialog")).toContainText(
    "余白カット：2 件",
  );
  await page.getByTestId("edit-reset-confirm").click();
  await expect
    .poll(() => Object.values(pageSizesOf(archive)))
    .toEqual([
      [400, 600],
      [400, 600],
      [400, 600],
    ]);
  await expect(page.getByTestId("edit-reset-dialog")).toBeHidden();
  await page
    .getByRole("combobox", { name: "保存済み編集の復元" })
    .selectOption("trim");
  await expect(page.getByTestId("edit-reset-confirm")).toBeDisabled();
});

test("検出中のページ数と進捗、完了結果と失敗を明示し、小さい窓でも一覧を動かさない", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "margin-progress.zip");
  runPython(
    `import io,sys,zipfile
from PIL import Image,ImageDraw
with zipfile.ZipFile(sys.argv[1],'w') as archive:
 for i in range(3):
  image=Image.new('RGB',(400,600),'white'); ImageDraw.Draw(image).rectangle((40,30,359,569),fill='black')
  buffer=io.BytesIO(); image.save(buffer,'PNG'); archive.writestr(f'{i+1:03d}.png',buffer.getvalue())`,
    archive,
  );
  let state: "running" | "real" | "failed" = "running";
  await page.route("**/api/jobs/**", async (route) => {
    const response = await route.fetch();
    const job = await response.json();
    if (
      route.request().method() === "GET" &&
      job.kind === "margin-scan" &&
      state !== "real"
    ) {
      await route.fulfill({
        response,
        json: {
          ...job,
          state,
          current: 2,
          total: 3,
          result: null,
          error: state === "failed" ? "検出に失敗しました（テスト）" : null,
        },
      });
    } else await route.fulfill({ response });
  });
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  await expect(page.getByTestId("margin-save")).toBeVisible();
  const primaryStyle = await page
    .getByTestId("margin-save")
    .evaluate((button) => ({
      color: getComputedStyle(button).backgroundColor,
      height: button.getBoundingClientRect().height,
    }));
  const top = (await page.getByTestId("split-grid").boundingBox())!.y;
  await expect(page.getByTestId("margin-progress")).toContainText(
    "全ページの余白を検出しています",
  );
  await expect(page.getByTestId("margin-progress")).toContainText(
    "2 / 3 ページ",
  );
  await expect(
    page.getByRole("progressbar", { name: "余白カットの進捗" }),
  ).toHaveAttribute("aria-valuenow", "67");
  await expect(page.getByTestId("margin-save")).toBeDisabled();
  expect((await page.getByTestId("split-grid").boundingBox())!.y).toBe(top);
  await page.screenshot({
    path: test.info().outputPath("margin-scanning.png"),
    animations: "disabled",
  });
  state = "real";
  await expect(page.getByTestId("margin-progress")).toHaveCount(0);
  await expect(page.getByTestId("margin-result")).toContainText("余白を検出");
  await expect(page.getByTestId("margin-save")).toHaveText("余白カットを反映");
  expect(
    await page.getByTestId("margin-save").evaluate((button) => ({
      color: getComputedStyle(button).backgroundColor,
      height: button.getBoundingClientRect().height,
    })),
  ).toEqual(primaryStyle);
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 860 },
    { width: 1000, height: 560 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId("margin-save")).toBeInViewport();
    await expect(page.getByTestId("margin-settings")).toBeInViewport();
    await expect(page.getByTestId("page-direction")).toBeInViewport();
    await page.getByTestId("margin-settings").click();
    await expect(
      page.getByRole("button", { name: "範囲を一覧で確認", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath(`margin-settings-${viewport.width}.png`),
    });
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath("margin-small.png") });
  state = "failed";
  await page.getByRole("button", { name: "再検出", exact: true }).click();
  await expect(page.getByTestId("margin-result")).toContainText(
    "検出に失敗しました（テスト）",
  );
  await expect(page.getByTestId("margin-progress")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "再検出", exact: true }),
  ).toBeEnabled();
});
