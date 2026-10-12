import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { runPython } from "./archive";
import { readFileSync } from "node:fs";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";
import { openCoverTools } from "./cover-tools";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

for (const [mode, selection] of [
  ["split", "all"],
  ["split", "detected"],
  ["split", "initial"],
  ["split", "manual"],
  ["merge", "all"],
]) {
  test(`未保存のサムネイル調整と${mode}の${selection}選択を一緒に反映できる`, async ({
    page,
  }) => {
    const archive = join(sidecar.workDir, `cover-with-${mode}.zip`);
    runPython(
      `
import io,sys,zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1],'w') as z:
    for name,color,size in [('001.png','red',(1200,900)),('002.png','blue',${mode === "split" ? "(1200,900)" : "(600,900)"}),('003.png','green',${mode === "split" ? "(1200,900)" : "(600,900)"})]:
        image=Image.new('RGB',size,color)
        data=io.BytesIO();image.save(data,'PNG');z.writestr(name,data.getvalue())
`,
      archive,
    );
    await page.goto(
      `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
    );
    await expect(page.getByTestId("margin-progress")).toHaveCount(0);
    const cover = page.getByTestId("editable-page").first();
    await expect(cover).toBeVisible();
    await cover.getByRole("button", { name: /の操作/ }).click();
    await cover.getByRole("menuitem", { name: "サムネイルの画像調整" }).click();
    await page.getByTestId("apply-thumbnail").click();
    await page.getByTestId(`split-step-${mode}`).click();
    if (selection === "manual") {
      await page.getByTestId("editor-select-none").click();
      for (const name of ["002.png", "003.png"])
        await page
          .locator(`[data-testid="editable-page"][data-name="${name}"]`)
          .getByTestId("split-check")
          .click();
    } else if (selection !== "initial")
      await page
        .getByTestId(
          selection === "detected"
            ? "editor-select-detected"
            : mode === "split"
              ? "split-all"
              : "merge-all",
        )
        .click();
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toHaveAttribute(
      "data-state",
      "done",
    );
    await expect(page.getByTestId("editor-notice")).toContainText(
      mode === "split" ? "分割しました" : "結合しました",
    );
    const sizes = JSON.parse(
      runPython(
        `
import io,json,sys,zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps([Image.open(io.BytesIO(z.read(n))).size for n in z.namelist() if not n.startswith('.') and n.endswith(('.jpg','.png'))]))
`,
        archive,
      ),
    );
    expect(sizes).toHaveLength(mode === "split" ? 5 : 2);
    expect(sizes[0][0]).toBeLessThan(sizes[0][1]);
    if (mode === "merge") expect(sizes[1]).toEqual([1200, 900]);
  });
}

for (const mode of ["trim", "split", "merge"]) {
  test(`${mode}: 変更なしの確認も保存中を表示し、確認後は全モードで押し直せない`, async ({
    page,
  }) => {
    const archive = writeArchive(sidecar.workDir, `review-${mode}.zip`, [
      { name: "001.jpg", color: "red" },
    ]);
    await page.goto(
      `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
    );
    await expect(page.getByTestId("margin-progress")).toHaveCount(0);
    await page.getByTestId(`split-step-${mode}`).click();
    const button = page.getByRole("button", {
      name: "確認済みにする",
      exact: true,
    });
    await expect(button).toBeEnabled();
    let held = true;
    await page.route("**/api/jobs/*", async (route) => {
      const response = await route.fetch();
      const job = await response.json();
      await route.fulfill({
        response,
        json:
          held && job.kind === "split"
            ? { ...job, state: "running", result: null }
            : job,
      });
    });
    await button.click();
    await expect(page.getByTestId("editor-progress")).toContainText(
      "変更を保存しています",
    );
    await page.screenshot({ path: test.info().outputPath("saving.png") });
    await expect(button).toBeDisabled();
    held = false;
    await expect(page.getByTestId("editor-progress")).toHaveCount(0);
    await expect(page.getByTestId("editor-notice")).toContainText("確認済み");
    for (const next of ["trim", "split", "merge"]) {
      await page.getByTestId(`split-step-${next}`).click();
      await expect(button).toBeDisabled();
    }
    const edits = await page.request.post(
      `${sidecar.baseUrl}/api/edits?token=${sidecar.token}`,
      { data: { paths: [archive] } },
    );
    expect((await edits.json()).edits[archive]).toContain("review");
  });
}

test("サムネイルの調整は保存前から一覧に描画し、取り消すと元画像へ戻る", async ({
  page,
}) => {
  const archive = join(sidecar.workDir, "draft-preview.zip");
  runPython(
    `
import io,sys,zipfile
from PIL import Image
image=Image.new('RGB',(600,900),'red')
image.paste('blue',(300,0,600,900))
data=io.BytesIO();image.save(data,'PNG')
with zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('001.png',data.getvalue())
`,
    archive,
  );
  const before = readFileSync(archive);
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  await openCoverTools(page);
  await page.getByTestId("rotate").click();
  await expect
    .poll(() =>
      page.locator('[data-testid="cover-frame"] canvas').evaluate((canvas) => {
        const image = canvas as HTMLCanvasElement;
        return image
          .getContext("2d")!
          .getImageData(image.width / 4, image.height / 4, 1, 1).data[3];
      }),
    )
    .toBe(255);
  const expected = await page
    .locator('[data-testid="cover-frame"] canvas')
    .evaluate((canvas) => {
      const image = canvas as HTMLCanvasElement;
      return [0.25, 0.75].flatMap((y) =>
        [0.25, 0.75].flatMap((x) =>
          Array.from(
            image
              .getContext("2d")!
              .getImageData(image.width * x, image.height * y, 1, 1).data,
          ).slice(0, 3),
        ),
      );
    });
  await page.getByTestId("apply-thumbnail").click();
  const preview = page.getByTestId("editable-page").first().locator("canvas");
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate((canvas) => {
        const image = canvas as HTMLCanvasElement;
        return [0.25, 0.75].flatMap((y) =>
          [0.25, 0.75].flatMap((x) =>
            Array.from(
              image
                .getContext("2d")!
                .getImageData(image.width * x, image.height * y, 1, 1).data,
            ).slice(0, 3),
          ),
        );
      }),
    )
    .toEqual(expected);
  expect(readFileSync(archive)).toEqual(before);
  expect(expected).toEqual([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
  await expect(page.getByTestId("editor-draft-notice")).toContainText("調整後");
  await page.screenshot({
    path: test.info().outputPath("thumbnail-preview.png"),
  });
  await openCoverTools(page);
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(preview).toBeVisible();
  await page.getByTestId("split-reset").click();
  await expect(preview).toHaveCount(0);
  expect(readFileSync(archive)).toEqual(before);
  await openCoverTools(page);
  await page.getByTestId("rotate").click();
  await page.getByTestId("apply-thumbnail").click();
  let held = true;
  await page.route("**/api/jobs/*", async (route) => {
    const response = await route.fetch();
    const job = await response.json();
    await route.fulfill({
      response,
      json:
        held && job.kind === "split"
          ? { ...job, state: "running", result: null }
          : job,
    });
  });
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("editor-progress")).toContainText(
    "保存しています",
  );
  held = false;
  await expect(page.getByTestId("editor-progress")).toHaveCount(0);
  await expect(page.getByTestId("editor-notice")).toContainText("保存しました");
  await expect(preview).toHaveCount(0);
  const saved = JSON.parse(
    runPython(
      `
import io,json,sys,zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1]) as z:
    name=next(n for n in z.namelist() if not n.startswith('.') and n.endswith(('.jpg','.png')))
    image=Image.open(io.BytesIO(z.read(name))).convert('RGB')
    print(json.dumps([c for y in [.25,.75] for x in [.25,.75] for c in image.getpixel((int(image.width*x),int(image.height*y)))]))
`,
      archive,
    ),
  );
  expect(saved).toHaveLength(expected.length);
  saved.forEach((value: number, index: number) =>
    expect(Math.abs(value - expected[index])).toBeLessThan(10),
  );
});
