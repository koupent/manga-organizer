import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";
import { pageEntriesOf, runPython } from "./archive";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

async function painted(page: Page, expected: string[]) {
  await expect(async () => {
    const cards = page.getByTestId("editable-page");
    await expect(cards).toHaveCount(expected.length);
    const shots = [];
    for (let i = 0; i < expected.length; i++) {
      const path = join(sidecar.workDir, `reused-${i}.png`);
      writeFileSync(path, await cards.nth(i).locator("img").screenshot());
      shots.push(path);
    }
    const colors = JSON.parse(
      runPython(
        `
import json,sys
from PIL import Image
colors=[]
for path in sys.argv[1:]:
 with Image.open(path) as image:
  pixel=image.convert('RGB').getpixel((int(image.width*.15),int(image.height*.15)))
  colors.append(['red','green','blue'][max(range(3),key=lambda i:pixel[i])])
print(json.dumps(colors))`,
        ...shots,
      ),
    );
    expect(colors).toEqual(expected);
  }).toPass({ timeout: 20000 });
}

test("本を削除して番号を詰め、同じ名前へ再整理しても、ページ一覧と画像を取り直す", async ({
  page,
}) => {
  const output = join(sidecar.workDir, "out");
  const series = "[著者] 作品";
  mkdirSync(join(output, series), { recursive: true });
  const name = `${series} 第002巻`;
  const make = (filename: string, colors: string[]) =>
    writeArchive(
      sidecar.workDir,
      filename,
      colors.map((color, i) => ({ name: `00${i + 1}.jpg`, color })),
    );
  const archive = make(join("out", series, `${name}.zip`), [
    "red",
    "green",
    "blue",
  ]);
  make(join("out", series, `${name}_1.zip`), ["blue", "red"]);
  const source = make("追加_02.zip", ["green", "blue"]);
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
      '[data-testid="browse-entry"][data-name="追加_02.zip"] .browser-name',
    )
    .click();
  await page.getByTestId("browse-close").click();
  const first = () =>
    page.locator(
      `[data-testid="plan-row"][data-existing][data-output-name="${name}.zip"]`,
    );
  await expect(first()).toHaveCount(1);
  await first().getByTestId("plan-to-edit").click();
  await page.getByTestId("split-step-split").click();
  await painted(page, ["red", "green", "blue"]);
  await page.getByTestId("mode-organize").click();
  await first().getByTestId("plan-trash").click();
  await page.getByTestId("trash-confirm").click();
  await expect(page.getByTestId("organize-status")).toContainText(
    "番号を詰め直しました",
  );
  expect(pageEntriesOf(archive)).toHaveLength(2);
  await first().getByTestId("plan-to-edit").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("2 ページ");
  await painted(page, ["blue", "red"]);

  // 同じ名前を、今度は新しく整理した別の本に使う。
  await page.getByTestId("mode-organize").click();
  await first().getByTestId("plan-trash").click();
  await page.getByTestId("trash-confirm").click();
  await expect(first()).toHaveCount(0);
  const input = page.locator(
    `[data-testid="plan-row"][data-source=${JSON.stringify(source)}]`,
  );
  await input.getByTestId("plan-check").check();
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("organize-status")).toContainText(
    "整理しました",
  );
  const made = page.locator('[data-testid="plan-row"][data-made]');
  await made.getByTestId("plan-to-edit").click();
  await expect(page.getByTestId("split-page-count")).toHaveText("2 ページ");
  await painted(page, ["green", "blue"]);
});
