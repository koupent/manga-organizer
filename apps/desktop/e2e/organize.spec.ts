import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

const CORE_DIR = fileURLToPath(
  new URL("../../../services/core", import.meta.url),
);

/** 辞書保存を遅らせる幅。この間はジョブ番号がまだ無い */
const SAVE_DELAY_MS = 2_000;

/** 外部検索の応答を遅らせる幅。入力中に届く状況を作る */
const LATE_SEARCH_MS = 1_500;

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => sidecar?.stop());

/** 出力先に生成されたファイルを列挙する */
function producedFiles(root: string): string[] {
  const output = execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      `
import sys
from pathlib import Path
root = Path(sys.argv[1])
if root.exists():
    for path in sorted(root.rglob("*")):
        if path.is_file():
            print(path.relative_to(root).as_posix())
`,
      root,
    ],
    { cwd: CORE_DIR, encoding: "utf8" },
  );
  return output.trim() ? output.trim().split("\n") : [];
}

/** ファイルブラウザから対象を選ぶ。実パスはサーバー側が返す */
async function selectArchives(page: Page, paths: string[]) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  for (const path of paths) {
    const name = path.split("/").pop()!;
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${name}"] .browser-name`,
      )
      .click();
  }
  await expect(page.getByTestId("selected-count")).toHaveText(
    `${paths.length} 件`,
  );
  await page.getByTestId("open-browser").click();
}

async function openOrganize(page: Page, output: string) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/**
 * 出力先を渡さずにファイル整理画面を開く。
 *
 * openOrganize() は URL で output を渡してしまうので、出力先の既定値を
 * 見るテストには空のまま始まる経路が要る。
 */
async function openOrganizeWithoutOutput(page: Page) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize`,
  );
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("output-directory")).toHaveValue("");
}

/**
 * ファイルブラウザを辿って 1 件だけ追加する。
 *
 * directory を渡すとその下へ入ってから選ぶ。追加した順番が分かるよう、
 * selectArchives() と違って 1 件ずつ扱う。
 */
async function addArchiveViaBrowser(
  page: Page,
  archive: string,
  directory?: string,
) {
  const name = archive.split("/").pop()!;
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  if (directory) {
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${directory}"] .browser-name`,
      )
      .click();
  }
  await page
    .locator(`[data-testid="browse-entry"][data-name="${name}"] .browser-name`)
    .click();
  await expect(
    page.locator(`[data-testid="selected-item"][data-path="${archive}"]`),
  ).toBeVisible();
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeHidden();
}

/**
 * 外部検索を「候補なし」に固定する。
 *
 * 作品名を 2 文字以上入れると 400ms 後に /api/library/suggest を呼び、
 * サイドカーは実際に AniList へ問い合わせる。検索そのものを見ないテストまで
 * 外部サービスの速度と可用性に左右されるので、応答を差し替えて切り離す。
 */
async function stubNoSuggestions(page: Page) {
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ author: null, candidates: [] }),
    }),
  );
}

/**
 * 辞書への保存を遅らせ、「実行中だがジョブ投入前」の状態を長く保つ。
 *
 * run() は saveEntry() と organize() を待ってから jobId を持つ。
 * その手前の状態を作るのにタイミング任せにしないための細工。
 */
async function delaySaveEntry(page: Page, delayMs: number) {
  await page.route("**/api/library/entries*", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return route.continue();
  });
}

/** 作品名と著者を入れる。作品名の変更で著者が引き直されるので、著者は後に入れる */
async function fillMangaInfo(page: Page, title: string, author: string) {
  // 外部検索を見ないテストが AniList に出ていかないようにする
  await stubNoSuggestions(page);
  await page.getByTestId("organize-title").fill(title);
  await page.getByTestId("organize-author").fill(author);
  await expect(page.getByTestId("organize-author")).toHaveValue(author);
}

test.describe("整理画面", () => {
  test("作品名と著者を決めて、選んだアーカイブを一括で整理できる", async ({
    page,
  }) => {
    // Arrange - 同じ作品の 2 冊
    const paths = [
      writeArchive(sidecar.workDir, "raw_01.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
      writeArchive(sidecar.workDir, "raw_02.zip", [
        { name: "001.jpg", color: "#00ff00" },
      ]),
    ];
    const output = join(sidecar.workDir, "out");
    mkdirSync(output, { recursive: true });

    await openOrganize(page, output);

    // Act - 上で作品情報を決め、下に対象を並べ、まとめて実行する
    await fillMangaInfo(page, "ワンピース", "尾田栄一郎");
    await selectArchives(page, paths);
    await page.getByTestId("confirm").click();

    // Assert - 入力した作品名と著者で出力される
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 30_000 },
    );
    const produced = producedFiles(output);
    expect(produced.length).toBeGreaterThan(0);
    expect(produced.every((path) => path.includes("ワンピース"))).toBeTruthy();
    expect(produced.every((path) => path.includes("尾田栄一郎"))).toBeTruthy();
    expect(produced.every((path) => path.endsWith(".zip"))).toBeTruthy();
  });

  test("実行した組み合わせは辞書に残り、次に選ぶと著者が埋まる", async ({
    page,
  }) => {
    // Arrange
    const paths = [
      writeArchive(sidecar.workDir, "辞書テスト.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
    ];
    const output = join(sidecar.workDir, "out-library");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);

    // Act - 一度実行する
    await fillMangaInfo(page, "辞書に残る作品", "テスト著者");
    await selectArchives(page, paths);
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 30_000 },
    );

    // Assert - 開き直して同じ作品名を入れると著者が戻る
    await openOrganize(page, output);
    await expect(
      page.locator('#known-titles option[value="辞書に残る作品"]'),
    ).toHaveCount(1);
    await page.getByTestId("organize-title").fill("辞書に残る作品");
    await expect(page.getByTestId("organize-author")).toHaveValue("テスト著者");
    await expect(page.getByTestId("organize-author")).toHaveAttribute(
      "data-source",
      "library",
    );
  });

  test("作品名から著者を検索して候補を出す", async ({ page }) => {
    // Arrange - 外部検索の応答を差し替える。実際のネットワークには出さない
    await openOrganize(page, join(sidecar.workDir, "out-search"));
    await page.route("**/api/library/suggest*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: "検索で見つかる作品",
          author: "検索の著者A",
          candidates: [
            {
              title: "検索で見つかる作品",
              author: "検索の著者A",
              source: "AniList",
              similarity: 1,
            },
            {
              title: "検索で見つかる作品 外伝",
              author: "検索の著者B",
              source: "AniList",
              similarity: 0.9,
            },
          ],
        }),
      }),
    );

    // Act - 辞書に無い作品名を入れる
    await page.getByTestId("organize-title").fill("検索で見つかる作品");

    // Assert - 先頭が入り、近い順の候補も選べる
    await expect(page.getByTestId("organize-author")).toHaveValue(
      "検索の著者A",
    );
    await expect(page.getByTestId("organize-author")).toHaveAttribute(
      "data-source",
      "search",
    );
    await expect(page.getByTestId("author-candidate")).toHaveCount(2);

    // Act - 2 番目の候補を選ぶ
    await page
      .locator('[data-testid="author-candidate"][data-author="検索の著者B"]')
      .click();

    // Assert
    await expect(page.getByTestId("organize-author")).toHaveValue(
      "検索の著者B",
    );
  });

  test("辞書にある作品名は検索せずに著者を埋める", async ({ page }) => {
    // Arrange - 辞書に入っていれば外部検索は不要
    let searched = false;
    await openOrganize(page, join(sidecar.workDir, "out-no-search"));
    await page.route("**/api/library/suggest*", (route) => {
      searched = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ author: null, candidates: [] }),
      });
    });

    // 先に辞書へ入れる
    await page.evaluate(
      async ([base, token]) => {
        await fetch(`${base}/api/library/entries?token=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "辞書だけの作品",
            author: "辞書の著者",
          }),
        });
      },
      [sidecar.baseUrl, sidecar.token],
    );
    await openOrganize(page, join(sidecar.workDir, "out-no-search"));
    await expect(
      page.locator('#known-titles option[value="辞書だけの作品"]'),
    ).toHaveCount(1);

    // Act
    await page.getByTestId("organize-title").fill("辞書だけの作品");

    // Assert
    await expect(page.getByTestId("organize-author")).toHaveValue("辞書の著者");
    await expect(page.getByTestId("organize-author")).toHaveAttribute(
      "data-source",
      "library",
    );
    expect(searched).toBe(false);
  });

  test("作品名を変えると前の著者は残らない", async ({ page }) => {
    // Arrange - 外部検索は fillMangaInfo が「候補なし」に固定する
    await openOrganize(page, join(sidecar.workDir, "out-reset"));
    await fillMangaInfo(page, "最初の作品", "最初の著者");

    // Act - 辞書にも外部にも無い作品名へ変える
    await page.getByTestId("organize-title").fill("まったく別の作品zzz");

    // Assert
    await expect(page.getByTestId("organize-author")).toHaveValue("");
  });

  test("作品名と著者が空のままでは実行しない", async ({ page }) => {
    // Arrange
    const paths = [
      writeArchive(sidecar.workDir, "未入力.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
    ];
    const output = join(sidecar.workDir, "out-empty");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await selectArchives(page, paths);

    // Act
    await page.getByTestId("confirm").click();

    // Assert - 何も出力されず、足りない項目を伝える
    await expect(page.getByTestId("organize-status")).toContainText(
      "作品名を入れてください",
    );
    expect(producedFiles(output)).toEqual([]);
  });

  test("処理対象の順番をドラッグで入れ替えられる", async ({ page }) => {
    // Arrange
    const paths = [
      writeArchive(sidecar.workDir, "順番A.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
      writeArchive(sidecar.workDir, "順番B.zip", [
        { name: "001.jpg", color: "#00ff00" },
      ]),
    ];
    await openOrganize(page, join(sidecar.workDir, "out-order"));
    await selectArchives(page, paths);

    const items = page.getByTestId("selected-item");
    await expect(items.nth(0)).toHaveAttribute("data-path", paths[0]);

    // Act - 1 件目を 2 件目の下へ運ぶ
    const grip = items.nth(0).getByTestId("selected-grip");
    const from = (await grip.boundingBox())!;
    const to = (await items.nth(1).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height, { steps: 12 });
    await page.mouse.up();

    // Assert
    await expect(items.nth(0)).toHaveAttribute("data-path", paths[1]);
    await expect(items.nth(1)).toHaveAttribute("data-path", paths[0]);
  });

  test("Delete キーで処理対象から外せる", async ({ page }) => {
    // Arrange
    const paths = [
      writeArchive(sidecar.workDir, "削除対象A.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
      writeArchive(sidecar.workDir, "削除対象B.zip", [
        { name: "001.jpg", color: "#00ff00" },
      ]),
    ];
    await openOrganize(page, join(sidecar.workDir, "out-delete"));
    await selectArchives(page, paths);

    // Act
    await page.getByTestId("selected-item").nth(0).focus();
    await page.keyboard.press("Delete");

    // Assert
    await expect(page.getByTestId("selected-count")).toHaveText("1 件");
    await expect(page.getByTestId("selected-item")).toHaveAttribute(
      "data-path",
      paths[1],
    );
  });

  test("処理の経過がログに出る", async ({ page }) => {
    // Arrange
    const paths = [
      writeArchive(sidecar.workDir, "ログ確認.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
    ];
    const output = join(sidecar.workDir, "out-log");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);

    // Act
    await fillMangaInfo(page, "ログの作品", "ログの著者");
    await selectArchives(page, paths);
    await page.getByTestId("confirm").click();

    // Assert - 対象のファイル名が経過に残る
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("organize-log")).toContainText(
      "ログ確認.zip",
    );
  });

  test("中断すると残りのファイルを整理しない", async ({ page }) => {
    // Arrange - 1 冊あたりを重くして、押した先が全部終わっているを避ける
    const paths = Array.from({ length: 8 }, (_, index) =>
      writeArchive(
        sidecar.workDir,
        `中断${index + 1}.zip`,
        Array.from({ length: 10 }, (_, pageIndex) => ({
          name: `${String(pageIndex + 1).padStart(3, "0")}.jpg`,
          color: "#ff0000",
        })),
      ),
    );
    const output = join(sidecar.workDir, "out-cancel");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    // ジョブ投入の手前で必ず止まるようにする
    await delaySaveEntry(page, SAVE_DELAY_MS);

    await fillMangaInfo(page, "中断の作品", "中断の著者");
    await selectArchives(page, paths);

    // Act - 走り出してすぐ、ジョブ番号がまだ無いうちに中断する
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("cancel")).toBeVisible();
    await page.getByTestId("cancel").click();
    await expect(page.getByTestId("organize-status")).toHaveText(
      "中断しています...",
    );

    // Assert - 失敗ではなく中断として扱われ、全件ぶんは出力されない
    await expect(page.getByTestId("organize-status")).toHaveText(
      "中断しました",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("cancel")).toBeHidden();
    expect(producedFiles(output).length).toBeLessThan(paths.length);
  });

  test("検索の応答が遅れても、手で入れた著者は上書きされない", async ({
    page,
  }) => {
    // Arrange - 応答をわざと遅らせ、入力中に届く状況を作る
    await openOrganize(page, join(sidecar.workDir, "out-late-search"));
    let requested = false;
    await page.route("**/api/library/suggest*", async (route) => {
      requested = true;
      await new Promise((resolve) => setTimeout(resolve, LATE_SEARCH_MS));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: "遅れて届く作品",
          author: "検索の著者",
          candidates: [
            {
              title: "遅れて届く作品",
              author: "検索の著者",
              source: "AniList",
              similarity: 1,
            },
          ],
        }),
      });
    });

    // Act - 検索が飛んだあと、応答が届く前に著者を手で入れる
    await page.getByTestId("organize-title").fill("遅れて届く作品");
    await expect.poll(() => requested).toBe(true);
    await page.getByTestId("organize-author").fill("手で入れた著者");
    await expect(page.getByTestId("organize-author")).toHaveValue(
      "手で入れた著者",
    );

    // Assert - 応答が届いても、手で入れた著者はそのまま残る
    await expect(page.getByTestId("author-candidate")).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("organize-author")).toHaveValue(
      "手で入れた著者",
    );
  });

  test("整理の実行中は処理対象の一覧を変えられない", async ({ page }) => {
    // Arrange
    const paths = Array.from({ length: 3 }, (_, index) =>
      writeArchive(sidecar.workDir, `実行中${index + 1}.zip`, [
        { name: "001.jpg", color: "#ff0000" },
        { name: "002.jpg", color: "#00ff00" },
      ]),
    );
    const output = join(sidecar.workDir, "out-locked");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    // 実行中の状態を保ったまま操作を試せるようにする
    await delaySaveEntry(page, SAVE_DELAY_MS);

    await fillMangaInfo(page, "実行中の作品", "実行中の著者");
    await selectArchives(page, paths);

    // Act - 実行中に一覧から 1 件外そうとする
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("cancel")).toBeVisible();
    await page
      .getByTestId("selected-item")
      .first()
      .getByRole("button", { name: "一覧から外す" })
      .click();

    // Assert - 実際に処理される内容と食い違わないよう、一覧は変わらない
    await expect(page.getByTestId("selected-count")).toHaveText("3 件");
    await expect(page.getByTestId("selected-item")).toHaveCount(3);
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("selected-count")).toHaveText("3 件");
  });

  test("進捗と状態が支援技術に伝わる", async ({ page }) => {
    // Arrange
    const paths = [
      writeArchive(sidecar.workDir, "読み上げ.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
    ];
    const output = join(sidecar.workDir, "out-a11y");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);

    // Act
    await fillMangaInfo(page, "読み上げの作品", "読み上げの著者");
    await selectArchives(page, paths);
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 30_000 },
    );

    // Assert - 進捗は progressbar として、状態は status として読み上げられる
    const progress = page.getByRole("progressbar");
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("aria-valuenow", /^\d+$/);
    await expect(progress).toHaveAttribute("aria-valuemax", /^\d+$/);
    await expect(page.getByRole("status")).toContainText("整理しました");
  });

  test("キーボードだけで処理対象の順番を入れ替えられる", async ({ page }) => {
    // Arrange
    const paths = [
      writeArchive(sidecar.workDir, "キー順A.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
      writeArchive(sidecar.workDir, "キー順B.zip", [
        { name: "001.jpg", color: "#00ff00" },
      ]),
    ];
    await openOrganize(page, join(sidecar.workDir, "out-key-order"));
    await selectArchives(page, paths);

    const items = page.getByTestId("selected-item");
    await expect(items.nth(0)).toHaveAttribute("data-path", paths[0]);

    // Act - ハンドルにフォーカスし、Space で掴んで ↓ で送り、Space で置く
    await items.nth(0).getByTestId("selected-grip").focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");

    // Assert
    await expect(items.nth(0)).toHaveAttribute("data-path", paths[1]);
    await expect(items.nth(1)).toHaveAttribute("data-path", paths[0]);
  });

  test("辞書ボタンで辞書がダイアログとして開く", async ({ page }) => {
    // Arrange
    await openOrganize(page, join(sidecar.workDir, "out-nav"));

    // Act
    await page.getByTestId("open-library").click();

    // Assert - モードは切り替わらず、ファイル整理の上に辞書が重なる
    await expect(page.getByTestId("library-dialog")).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByTestId("entry-count")).toBeVisible();
    await expect(page.getByTestId("mode-organize")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Act - 閉じる
    await page.getByTestId("library-close").click();

    // Assert - 元のファイル整理画面に戻る
    await expect(page.getByTestId("library-dialog")).toBeHidden();
    await expect(page.getByTestId("organize-title")).toBeVisible();
  });

  test("辞書ダイアログを開いて閉じても、入力途中の作品情報と処理対象の一覧が残っている", async ({
    page,
  }) => {
    // Arrange - 入力の途中で辞書を見に行く状況を作る
    const paths = [
      writeArchive(sidecar.workDir, "保持A.zip", [
        { name: "001.jpg", color: "#ff0000" },
      ]),
      writeArchive(sidecar.workDir, "保持B.zip", [
        { name: "001.jpg", color: "#00ff00" },
      ]),
    ];
    const output = join(sidecar.workDir, "out-keep-state");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await fillMangaInfo(page, "保持される作品", "保持される著者");
    await selectArchives(page, paths);

    // Act - 辞書を開いて閉じる
    await page.getByTestId("open-library").click();
    await expect(page.getByTestId("library-dialog")).toBeVisible();
    await page.getByTestId("library-close").click();
    await expect(page.getByTestId("library-dialog")).toBeHidden();

    // Assert - 入力途中の作品情報がそのまま残る
    await expect(page.getByTestId("organize-title")).toHaveValue(
      "保持される作品",
    );
    await expect(page.getByTestId("organize-author")).toHaveValue(
      "保持される著者",
    );
    await expect(page.getByTestId("output-directory")).toHaveValue(output);

    // Assert - 処理対象の一覧も順番ごと残る
    await expect(page.getByTestId("selected-count")).toHaveText("2 件");
    const items = page.getByTestId("selected-item");
    await expect(items.nth(0)).toHaveAttribute("data-path", paths[0]);
    await expect(items.nth(1)).toHaveAttribute("data-path", paths[1]);
  });

  test("ファイル整理とページ並べ替えを切り替えられる", async ({ page }) => {
    await openOrganize(page, join(sidecar.workDir, "out-mode"));
    await page.getByTestId("mode-reorder").click();
    await expect(page.getByTestId("mode-reorder")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("organize-title")).toBeHidden();
  });
});

test.describe("タブ", () => {
  test("タブは ファイル整理 / サムネイル作成 / ページ並べ替え の 3 つで、辞書は無い", async ({
    page,
  }) => {
    // Arrange
    await openOrganize(page, join(sidecar.workDir, "out-tabs"));

    // Assert - 機能を表す名前が並ぶ
    await expect(page.getByTestId("mode-organize")).toHaveText("ファイル整理");
    await expect(page.getByTestId("mode-thumbnail")).toHaveText(
      "サムネイル作成",
    );
    await expect(page.getByTestId("mode-reorder")).toHaveText("ページ並べ替え");

    // Assert - 辞書はタブから外れ、ファイル整理の中のボタンから開く
    await expect(page.getByTestId("mode-library")).toHaveCount(0);
    await expect(page.getByTestId("open-library")).toBeVisible();
  });
});

test.describe("出力先の既定", () => {
  test("出力先が空のとき、最初に追加したファイルの場所が出力先になる", async ({
    page,
  }) => {
    // Arrange - 親ディレクトリが根と違うことが分かるよう、下位に置く
    const directory = "既定サブ";
    mkdirSync(join(sidecar.workDir, directory), { recursive: true });
    const archive = writeArchive(sidecar.workDir, `${directory}/既定A.zip`, [
      { name: "001.jpg", color: "#ff0000" },
    ]);
    await openOrganizeWithoutOutput(page);

    // Act
    await addArchiveViaBrowser(page, archive, directory);

    // Assert - 元の Tkinter 実装と同じく、そのファイルの親ディレクトリが入る
    await expect(page.getByTestId("output-directory")).toHaveValue(
      join(sidecar.workDir, directory),
    );
  });

  test("既に出力先が入っているときはファイルを追加しても上書きしない", async ({
    page,
  }) => {
    // Arrange - 先に選んである出力先を勝手に変えない
    const output = join(sidecar.workDir, "out-fixed");
    mkdirSync(output, { recursive: true });
    const archive = writeArchive(sidecar.workDir, "上書き確認.zip", [
      { name: "001.jpg", color: "#00ff00" },
    ]);
    await openOrganize(page, output);

    // Act
    await addArchiveViaBrowser(page, archive);

    // Assert
    await expect(page.getByTestId("output-directory")).toHaveValue(output);
  });

  test("2 つ目以降のファイルを追加しても出力先は変わらない", async ({
    page,
  }) => {
    // Arrange - 1 件目は根、2 件目は別のディレクトリに置く
    const first = writeArchive(sidecar.workDir, "並び1.zip", [
      { name: "001.jpg", color: "#0000ff" },
    ]);
    const directory = "既定サブ2";
    mkdirSync(join(sidecar.workDir, directory), { recursive: true });
    const second = writeArchive(sidecar.workDir, `${directory}/並び2.zip`, [
      { name: "001.jpg", color: "#ffff00" },
    ]);
    await openOrganizeWithoutOutput(page);

    // Act - 1 件目で既定が決まる
    await addArchiveViaBrowser(page, first);
    await expect(page.getByTestId("output-directory")).toHaveValue(
      sidecar.workDir,
    );

    // Act - 2 件目は別の場所から追加する
    await addArchiveViaBrowser(page, second, directory);

    // Assert - 既定は 1 件目のままで、追加のたびに動かない
    await expect(page.getByTestId("output-directory")).toHaveValue(
      sidecar.workDir,
    );
  });
});
