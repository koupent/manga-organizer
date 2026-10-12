import { expect, test } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

test.use({ storageState: { cookies: [], origins: [] } });
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

test("編集対象がある時だけ案内し、閉じる状態と今後表示しない設定を保持する", async ({
  page,
}) => {
  const archive = writeArchive(sidecar.workDir, "guide.zip", [
    { name: "001.png", color: "#336699" },
  ]);
  const params = new URLSearchParams({
    api: sidecar.baseUrl,
    token: sidecar.token,
    mode: "edit",
  });
  await page.goto(`/?${params}`);
  await expect(
    page.getByText("編集するファイル", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("editor-guide")).toHaveCount(0);

  params.set("archive", archive);
  params.set("mode", "organize");
  await page.goto(`/?${params}`);
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("editor-guide")).toHaveCount(0);
  await page.getByTestId("mode-edit").click();
  const guide = page.getByTestId("editor-guide");
  await expect(guide).toBeVisible();
  await expect(guide.locator("section svg")).toHaveCount(3);
  for (const title of ["余白カット", "ページ分割", "ページ結合"]) {
    await expect(
      guide.getByRole("heading", { name: new RegExp(title) }),
    ).toBeVisible();
  }
  await page.screenshot({ path: "test-results/editor-guide.png" });
  await guide.getByRole("button", { name: "編集を始める" }).click();
  await page.getByTestId("mode-organize").click();
  await page.getByTestId("mode-edit").click();
  await expect(guide).toHaveCount(0);

  params.set("mode", "edit");
  await page.goto(`/?${params}`);
  await expect(guide).toBeVisible();
  await guide.getByRole("checkbox", { name: "今後表示しない" }).check();
  await expect(guide).toBeVisible();
  await guide.getByRole("button", { name: "編集を始める" }).click();
  await page.reload();
  await expect(page.getByTestId("editable-page")).toBeVisible();
  await expect(guide).toHaveCount(0);
});
