import { expect, test, type Page, type Route } from "@playwright/test";
import { basename } from "node:path";
import { coloursOf, derivedRecordsOf, pageSizesOf } from "./archive";
import { openCoverTools } from "./cover-tools";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * 保存を押した直後に、ディレクトリ整理へ移って別の本を開く。
 *
 * 保存の要求はテストが止めておき、別の本を開こうとしたあとで通す（または
 * 断らせる）。こうすると「保存が終わる前に次の本が始まる」並びを毎回同じ
 * 順番で作れる。保存できたかは画面ではなく ZIP の中身で確かめる。
 */

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

const SIDE_A = ["#aa2222", "#22aa22", "#2222aa"];
const WINDOWS_LOCK =
  "[WinError 32] プロセスはファイルにアクセスできません。別のプロセスが使用中です。";

function book(name: string) {
  return writeArchive(
    sidecar.workDir,
    name,
    SIDE_A.map((color, index) => ({ name: `00${index + 1}.jpg`, color })),
  );
}

async function openOrganize(page: Page, archives: string[]) {
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({ json: { author: null, candidates: [] } }),
  );
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "organize", output: sidecar.workDir })}`,
  );
  await page.getByTestId("open-browser").click();
  for (const archive of archives)
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${basename(archive)}"] .browser-name`,
      )
      .click();
  await page.getByTestId("browse-close").click();
}

/** 整理の行にある、その本の「編集」の近道。編集済みの印が付いても引ける */
const editButton = (page: Page, archive: string) =>
  page.getByRole("button", { name: new RegExp(`^${escaped(archive)} を編集`) });
const escaped = (archive: string) =>
  basename(archive).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 保存の要求を止める。返す関数で、止めた要求を通すか断らせる */
async function holdSave(page: Page) {
  let held!: (route: Route) => void;
  const arrived = new Promise<Route>((resolve) => (held = resolve));
  await page.route("**/api/jobs/split?*", (route) => held(route), {
    times: 1,
  });
  return arrived;
}

/** 保存を押した直後に、ディレクトリ整理へ移って B を開こうとする */
async function rushToAnotherBook(page: Page, other: string) {
  await page.getByTestId("mode-organize").click({ force: true });
  if (await editButton(page, other).isVisible())
    await editButton(page, other).click();
}

async function mergeFirstTwo(page: Page) {
  await page.getByTestId("split-step-merge").click();
  const cards = page.getByTestId("merge-card");
  await expect(cards).toHaveCount(3);
  await cards.first().hover();
  await cards.first().getByTestId("merge-pick").click();
  await cards.nth(1).getByTestId("merge-partner").click();
}

test("結合を保存した直後に別の本を開こうとしても、保存が終わるまで移らず結合が残る", async ({
  page,
}) => {
  const a = book("[著者] 保存競合 第001巻.zip");
  const b = book("[著者] 保存競合 第002巻.zip");
  await openOrganize(page, [a, b]);
  await editButton(page, a).click();
  await mergeFirstTwo(page);

  const save = holdSave(page);
  await page.getByTestId("split-confirm").click();
  const request = await save;
  await rushToAnotherBook(page, b);

  // 保存の最中は、画面も本も切り替わらない
  await expect(page.getByTestId("archive-name")).toHaveText(basename(a));
  await expect(page.getByTestId("mode-organize")).toBeDisabled();
  await expect(page.getByTestId("change-archive")).toBeDisabled();

  await request.continue();
  await expect(page.getByTestId("split-status")).toHaveAttribute(
    "data-state",
    "done",
  );
  expect(Object.values(pageSizesOf(a))).toEqual([
    [1200, 900],
    [600, 900],
  ]);

  // 保存が終われば移れる。B を開いてから A を開き直しても、結合は残っている
  await page.getByTestId("mode-organize").click();
  await editButton(page, b).click();
  await expect(page.getByTestId("archive-name")).toHaveText(basename(b));
  await expect(page.getByTestId("split-page-count")).toHaveText("3 ページ");
  await page.getByTestId("mode-organize").click();
  await editButton(page, a).click();
  await expect(page.getByTestId("archive-name")).toHaveText(basename(a));
  await expect(page.getByTestId("split-page-count")).toHaveText("2 ページ");
});

test("サムネイルの調整を保存した直後に別の本を開こうとしても、保存が終わるまで移らず調整が残る", async ({
  page,
}) => {
  const a = book("[著者] 表紙競合 第001巻.zip");
  const b = book("[著者] 表紙競合 第002巻.zip");
  await openOrganize(page, [a, b]);
  await editButton(page, a).click();
  await openCoverTools(page);
  await page.getByTestId("rotate").click();
  await expect(page.getByTestId("pending-rotation")).toBeVisible();
  await page.getByTestId("apply-thumbnail").click();
  await expect(page.getByTestId("editor-draft-notice")).toBeVisible();

  const save = holdSave(page);
  await page.getByTestId("split-confirm").click();
  const request = await save;
  await rushToAnotherBook(page, b);

  await expect(page.getByTestId("archive-name")).toHaveText(basename(a));
  await expect(page.getByTestId("mode-organize")).toBeDisabled();

  await request.continue();
  await expect(page.getByTestId("split-status")).toHaveAttribute(
    "data-state",
    "done",
  );
  const cover = Object.values(derivedRecordsOf(a)).flatMap((record) =>
    record.operations.map((operation) => operation.kind),
  );
  expect(cover).toContain("rotate");

  await page.getByTestId("mode-organize").click();
  await editButton(page, b).click();
  await expect(page.getByTestId("archive-name")).toHaveText(basename(b));
  expect(derivedRecordsOf(b)).toEqual({});
  await page.getByTestId("mode-organize").click();
  await expect(editButton(page, a)).toHaveAttribute("data-edited", "true");
});

test("別の本を開こうとした間に保存が断られても、A に留まって失敗を伝え、本は変わらない", async ({
  page,
}) => {
  const a = book("[著者] 保存失敗 第001巻.zip");
  const b = book("[著者] 保存失敗 第002巻.zip");
  const before = coloursOf(a);
  await openOrganize(page, [a, b]);
  await editButton(page, a).click();
  await mergeFirstTwo(page);

  const save = holdSave(page);
  await page.getByTestId("split-confirm").click();
  const request = await save;
  await rushToAnotherBook(page, b);
  await request.fulfill({ status: 409, json: { detail: WINDOWS_LOCK } });

  // 黙って B へ移らない。失敗はいま見ている A の画面に出たまま
  await expect(page.getByTestId("archive-name")).toHaveText(basename(a));
  await expect(page.getByTestId("editor-notice")).toContainText(WINDOWS_LOCK);
  await expect(page.getByTestId("split-confirm")).toBeEnabled();
  await expect(page.getByTestId("mode-organize")).toBeEnabled();
  expect(coloursOf(a)).toEqual(before);
});
