import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/*
  出力先（書き出す側）の守りを、画面から通しで見る。

  サイドカーは /api/jobs/organize の output_directory を検証していない。
  塞ぎ方は「ホーム以下に縛る」ではなく「利用者が選んだ場所を覚えて、そこへ
  だけ書き出す」。蔵書は 2 台目のドライブや NAS に置かれることが多く、
  出力先の入力欄は自由入力なので、縛ると今できていることが壊れるため。

  ここで見るのは、その境界が画面の操作と噛み合っていること。
  - 利用者が出力先を選べば、許可の外でも今までどおり整理できる
  - 誰も選んでいない出力先（起動パラメータで渡されただけの値）には書かない

  サイドカーには蔵書フォルダだけを許可させ、その外を「別ドライブ」として使う。
*/

/** 出力先を「利用者が選んだ」と伝える経路。まだ無い */
const CHOOSE_OUTPUT = "/api/output-roots";

let sidecar: Sidecar;

/** 許可の外。2 台目のドライブや NAS に当たる */
let outside: string;

test.beforeAll(async () => {
  sidecar = await startSidecar({ allowedSubdirectory: "蔵書" });
  outside = join(sidecar.workDir, "外のドライブ");
  mkdirSync(outside, { recursive: true });
});

test.afterAll(() => sidecar?.stop());

/** その場所に実際に出来上がったファイル。状態番号だけでは分からない */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

/** ファイル整理を開く。output を渡すと起動パラメータとして出力先に入る */
async function openOrganize(page: Page, output?: string) {
  const params =
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
    `&mode=organize` +
    (output ? `&output=${encodeURIComponent(output)}` : "");
  await page.goto(params);
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/** 作品名と著者を入れる。外部検索は「候補なし」に固定して切り離す */
async function fillMangaInfo(page: Page, title: string, author: string) {
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ author: null, candidates: [] }),
    }),
  );
  await page.getByTestId("organize-title").fill(title);
  await page.getByTestId("organize-author").fill(author);
  await expect(page.getByTestId("organize-author")).toHaveValue(author);
}

/** ファイルブラウザから対象を選ぶ。許可された蔵書フォルダから辿る */
async function selectArchive(page: Page, archive: string) {
  const name = archive.split("/").pop()!;
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  await page
    .locator(`[data-testid="browse-entry"][data-name="${name}"] .browser-name`)
    .click();
  await expect(page.getByTestId("selected-count")).toHaveText("1 件");
  await page.getByTestId("open-browser").click();
  await expect(
    page.locator('[data-testid="plan-row"][data-level="0"]'),
  ).toHaveCount(1);
}

test.describe("出力先の守り", () => {
  test("利用者が選んだ出力先なら、許可の外のドライブへも整理できる", async ({
    page,
  }) => {
    // Arrange - 対象は蔵書の中、出力先は許可の外
    const archive = writeArchive(sidecar.allowedRoot, "外へ出す_01.zip", [
      { name: "001.jpg", color: "#ff0000" },
    ]);
    const output = join(outside, "整理後");
    mkdirSync(output, { recursive: true });
    await openOrganize(page);
    await expect(page.getByTestId("output-directory")).toHaveValue("");

    // Act - 利用者が自分で出力先を入れる。この操作が「選んだ」に当たる
    const chose = page.waitForRequest(
      (request) =>
        request.url().includes(CHOOSE_OUTPUT) && request.method() === "POST",
      { timeout: 15_000 },
    );
    await page.getByTestId("output-directory").fill(output);

    // Assert - 選んだことがサイドカーへ届いている。ここが抜けたまま守りを
    // 足すと、別ドライブへ整理している利用者は次の版で何もできなくなる
    expect((await chose).postDataJSON()).toMatchObject({ directory: output });

    // Act - そのまま最後まで実行する
    await fillMangaInfo(page, "外のドライブの作品", "外のドライブの著者");
    await selectArchive(page, archive);
    await page.getByTestId("confirm").click();

    // Assert - 出来上がりが選んだ場所に置かれる。受け付けたかどうかだけでは
    // どこへ書いたかを何も言っていない
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 30_000 },
    );
    expect(filesUnder(output).length).toBeGreaterThan(0);
  });

  test("起動パラメータで渡されただけの出力先には書き出さない", async ({
    page,
  }) => {
    // Arrange - 出力先は URL から入る。利用者は入力欄に一度も触っていない。
    // 外から仕込める値なので、これを「選んだ」と数えると守りが素通しになる
    const archive = writeArchive(sidecar.allowedRoot, "仕込み_01.zip", [
      { name: "001.jpg", color: "#00ff00" },
    ]);
    const output = join(outside, "仕込まれた出力先");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await expect(page.getByTestId("output-directory")).toHaveValue(output);

    await fillMangaInfo(page, "仕込まれた作品", "仕込まれた著者");
    await selectArchive(page, archive);

    // Act
    const submitted = page.waitForResponse(
      (response) =>
        response.url().includes("/api/jobs/organize") &&
        response.request().method() === "POST",
    );
    await page.getByTestId("confirm").click();
    const response = await submitted;

    // Assert - 投入したその場で断る。ジョブにして後から失敗させると、
    // 画面は投入できたと思ったまま書き込みだけが済んでしまう
    expect(response.status()).toBe(400);
    const detail =
      ((await response.json()) as { detail?: string }).detail ?? "";
    expect(detail).not.toEqual("");

    // Assert - 1 バイトも書かれていない
    expect(filesUnder(output)).toEqual([]);

    // Assert - 断られたことが画面に出る。黙って何も起きないのが一番困る。
    // 文言は縛らず、サイドカーが返した理由がそのまま見えることを見る
    await expect(page.getByTestId("organize-status")).toContainText(detail);
    await expect(page.getByTestId("organize-status")).not.toContainText(
      "整理しました",
    );
  });
});
