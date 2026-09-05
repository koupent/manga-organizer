import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * 出力先に生成されたファイルの、ファイル名だけを列挙する。
 *
 * 出来たファイルは `[著者] 作品名/` の下に置かれる。画面に出るのは
 * ファイル名なので、照合にはここを使う。
 */
function producedNames(root: string): string[] {
  return producedFiles(root).map((path) => path.split("/").pop()!);
}

/**
 * 落としたものの行。
 *
 * 一覧は 3 階層になり（#70 第 3 段階）、落としたものは一番外側の行になる。
 * 出来上がる本の行も同じ testid で並ぶので、深さで絞り込む。
 */
function droppedRows(page: Page) {
  return page.locator('[data-testid="plan-row"][data-level="0"]');
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
  await expect(droppedRows(page)).toHaveCount(paths.length);
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
 *
 * ファイルブラウザは処理対象の一覧と入れ替わりに出るので、開いている間は
 * ブラウザ側の「追加済み」で、閉じてから一覧の行で、入ったことを確かめる。
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
    page.locator(`[data-testid="browse-entry"][data-name="${name}"]`),
  ).toContainText("追加済み");
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeHidden();
  await expect(
    page.locator(
      `[data-testid="plan-row"][data-level="0"][data-path="${archive}"]`,
    ),
  ).toBeVisible();
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

  test("作品名と著者が空のままでは実行できず、理由が見える", async ({
    page,
  }) => {
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

    // Assert - 揃っていないので押せない（#70 の確定仕様）
    await expect(
      page.getByTestId("confirm"),
      "作品名も著者も空なのに実行できてしまう",
    ).toBeDisabled();

    // Assert - 押せないだけでは何が足りないか分からない。理由が主操作の
    // 行に出る。ここが無いと、無効なボタンの前で利用者が詰まる
    await expect(page.getByTestId("organize-status")).toContainText(
      "作品名を入れてください",
    );
    await expect(page.getByTestId("organize-status")).toContainText(
      "著者を入れてください",
    );
    expect(producedFiles(output)).toEqual([]);

    // Assert - 埋めれば押せるようになる。常に無効な実装で通らないようにする
    await fillMangaInfo(page, "埋めた作品", "埋めた著者");
    await expect(page.getByTestId("confirm")).toBeEnabled();
  });

  /*
    「処理対象の順番をドラッグで入れ替えられる」と「キーボードだけで処理対象の
    順番を入れ替えられる」は、#70 第 3 段階の確定仕様「並べ替えのグリップは外す」
    （フォルダを放り込む形になり、順番に意味が無くなった）と両立しないため
    取り除いた。掴む所を出さないことは plan-list.spec.ts が見る。
  */

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

    // Act - 落としたものの行に焦点を当てて外す
    await droppedRows(page).nth(0).focus();
    await page.keyboard.press("Delete");

    // Assert
    await expect(page.getByTestId("selected-count")).toHaveText("1 件");
    await expect(droppedRows(page)).toHaveAttribute("data-path", paths[1]);
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

    const firstRow = droppedRows(page).first();
    const firstCheck = firstRow.getByTestId("plan-check");
    await expect(firstCheck).toHaveAttribute("aria-checked", "true");

    // Act - 実行中に一覧から 1 件外そうとする
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("cancel")).toBeVisible();

    // Assert - 外す操作もチェックも固定される。実際に処理される内容と
    // 食い違わないため、そして再実行で `_1` が二重に付かないため
    await expect(firstRow.getByTestId("plan-remove")).toBeDisabled();
    await expect(firstCheck).toBeDisabled();
    await firstCheck.click({ force: true });
    await expect(firstCheck).toHaveAttribute("aria-checked", "true");

    // Assert - 一覧は変わらない
    await expect(page.getByTestId("selected-count")).toHaveText("3 件");
    await expect(droppedRows(page)).toHaveCount(3);
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("selected-count")).toHaveText("3 件");
    // Assert - 3 冊とも出来ている。固定した結果として 1 件外れていない
    expect(producedNames(output)).toHaveLength(3);
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
    const items = droppedRows(page);
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

/**
 * 整理した直後に、出来たファイルから次の作業へ移れること。
 *
 * 3 つの機能はそれぞれ単独で完結する。ここで見るのは任意の近道であって、
 * 強制的なパイプラインではない。単独利用を壊していないことも併せて見る。
 */
test.describe("整理後の受け渡し", () => {
  /** 対象を選ばずにサムネイル作成・ページ並べ替えを開く */
  async function openMode(page: Page, mode: "thumbnail" | "reorder") {
    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&mode=${mode}`,
    );
    await expect(page.getByTestId(`mode-${mode}`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }

  /** ファイルブラウザを辿って対象を 1 件選ぶ */
  async function chooseArchiveViaBrowser(page: Page, archive: string) {
    const name = archive.split("/").pop()!;
    await page.getByTestId("open-browser").click();
    await expect(page.getByTestId("file-browser")).toBeVisible();
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${name}"] .browser-name`,
      )
      .click();
  }

  /** 作品情報を入れて対象を並べ、整理を最後まで走らせる */
  async function organizeAll(
    page: Page,
    title: string,
    author: string,
    paths: string[],
  ) {
    await fillMangaInfo(page, title, author);
    await selectArchives(page, paths);
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 30_000 },
    );
  }

  /**
   * 巻数の違う 2 冊を作る。
   *
   * ページ数を 2 と 3 で変えるのは、受け渡した先で「どちらのファイルが
   * 読み込まれたか」を名前だけでなく中身からも見分けるため。整理後の
   * ページ名は 001.jpg から振り直されるので、枚数が唯一の手がかりになる。
   */
  function writeVolumes(prefix: string): string[] {
    return [
      writeArchive(
        sidecar.workDir,
        `${prefix}_01.zip`,
        Array.from({ length: 2 }, (_, index) => ({
          name: `p${index + 1}.jpg`,
          color: "#ff0000",
        })),
      ),
      writeArchive(
        sidecar.workDir,
        `${prefix}_02.zip`,
        Array.from({ length: 3 }, (_, index) => ({
          name: `p${index + 1}.jpg`,
          color: "#00ff00",
        })),
      ),
    ];
  }

  test("整理が終わると出来たファイルが一覧で出る", async ({ page }) => {
    // Arrange - 元のファイル名と出来るファイル名は違う。名前が付け替わった
    // 後のものが並ぶことを見たいので、元の名前をそのまま出す実装は落とす
    const paths = writeVolumes("受け渡し一覧");
    const output = join(sidecar.workDir, "out-handoff-list");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);

    // Act
    await organizeAll(page, "受け渡しの作品", "受け渡しの著者", paths);

    // Assert - 実際に出来たファイルと、並んだ行が 1 対 1 で対応する
    const expected = producedNames(output);
    expect(expected).toHaveLength(2);
    const items = page.getByTestId("produced-item");
    await expect(items).toHaveCount(2);
    await expect(page.getByTestId("produced-name")).toHaveText(expected);

    // Assert - 行は出来たファイルの実パスを持つ。名前だけの飾りではない
    const absolute = producedFiles(output).map((path) => join(output, path));
    expect(
      await items.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-path")),
      ),
    ).toEqual(absolute);

    // Assert - 各行から次の作業へ移る導線がある
    for (const index of [0, 1]) {
      await expect(
        items.nth(index).getByTestId("produced-to-thumbnail"),
      ).toContainText("サムネイル");
      await expect(
        items.nth(index).getByTestId("produced-to-reorder"),
      ).toContainText("ページ");
    }
  });

  test("出来たファイルの行からサムネイル作成へ移ると、そのファイルが読み込まれている", async ({
    page,
  }) => {
    // Arrange
    const paths = writeVolumes("受け渡しサムネ");
    const output = join(sidecar.workDir, "out-handoff-thumbnail");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await organizeAll(page, "サムネへ渡す作品", "サムネへ渡す著者", paths);

    // Act - 先頭を渡して済ませる実装を落とすため、2 件目の行から移る
    const expected = producedNames(output);
    expect(expected).toHaveLength(2);
    await page
      .getByTestId("produced-item")
      .filter({ hasText: expected[1] })
      .getByTestId("produced-to-thumbnail")
      .click();

    // Assert - サムネイル作成へ移り、ドロップ領域ではなく編集面が出る
    await expect(page.getByTestId("mode-thumbnail")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("thumbnail-archive-name")).toHaveText(
      expected[1],
    );
    // ファイル整理は隠れるだけで残る（#67）ので、その中のドロップ領域も
    // DOM には居続ける。ここで見たいのは「移った先にドロップ領域が出ない」
    // ことなので、数ではなく見えているかどうかで確かめる
    await expect(page.getByTestId("dropzone")).toBeHidden();

    // Assert - 中身も 2 件目のもの。1 件目は 2 ページ、2 件目は 3 ページ
    await page.getByTestId("choose-page").click();
    await expect(page.getByTestId("thumbnail-candidate")).toHaveCount(3);
  });

  test("出来たファイルの行からページ並べ替えへ移ると、そのファイルが読み込まれている", async ({
    page,
  }) => {
    // Arrange
    const paths = writeVolumes("受け渡し並べ替え");
    const output = join(sidecar.workDir, "out-handoff-reorder");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await organizeAll(page, "並べ替えへ渡す作品", "並べ替えへ渡す著者", paths);

    // Act - こちらも 2 件目から移る
    const expected = producedNames(output);
    expect(expected).toHaveLength(2);
    await page
      .getByTestId("produced-item")
      .filter({ hasText: expected[1] })
      .getByTestId("produced-to-reorder")
      .click();

    // Assert - ページ並べ替えへ移り、ドロップ領域ではなく格子が出る
    await expect(page.getByTestId("mode-reorder")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("reorder-archive-name")).toHaveText(
      expected[1],
    );
    // 上と同じ理由。隠れて残っているファイル整理のドロップ領域は数に入る
    await expect(page.getByTestId("dropzone")).toBeHidden();

    // Assert - 中身も 2 件目のもの。ページ数で 1 件目と見分ける
    await expect(page.getByTestId("page-card")).toHaveCount(3);
  });

  test("整理する前は出来たファイルの一覧が出ない", async ({ page }) => {
    // Arrange
    const paths = writeVolumes("受け渡し実行前");
    const output = join(sidecar.workDir, "out-handoff-before");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);

    // Assert - 開いた直後は何も無い
    await expect(page.getByTestId("produced-item")).toHaveCount(0);
    await expect(page.getByTestId("produced-list")).toHaveCount(0);

    // Act - 作品情報を入れ、対象を並べるところまで進める
    await fillMangaInfo(page, "実行前の作品", "実行前の著者");
    await selectArchives(page, paths);

    // Assert - 処理対象が並んでも、出来たファイルはまだ無い。
    // 選んだファイルをそのまま出す実装はここで落ちる
    await expect(page.getByTestId("selected-count")).toHaveText("2 件");
    await expect(page.getByTestId("produced-item")).toHaveCount(0);
    await expect(page.getByTestId("produced-list")).toHaveCount(0);
    expect(producedFiles(output)).toEqual([]);
  });

  test("整理が失敗したときは出来たファイルの一覧が出ない", async ({ page }) => {
    // Arrange - 一度は成功させる。成功時の一覧が失敗後も居座らないことまで
    // 見たいので、何も出来ていない状態から失敗させるのでは足りない
    const paths = writeVolumes("受け渡し失敗");
    const output = join(sidecar.workDir, "out-handoff-failure");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await organizeAll(page, "失敗する作品", "失敗する著者", paths);
    await expect(page.getByTestId("produced-item")).toHaveCount(2);

    // Act - 処理対象を選んだ後に元ファイルが消えた状況を作り、もう一度実行する
    for (const path of paths) rmSync(path);
    await page.getByTestId("confirm").click();

    // Assert - 失敗として伝わる
    await expect(page.getByTestId("organize-status")).toContainText(
      "ファイルが見つかりません",
      { timeout: 30_000 },
    );

    // Assert - 出来ていないものの一覧は出ない。前回ぶんも残らない
    await expect(page.getByTestId("produced-item")).toHaveCount(0);
    await expect(page.getByTestId("produced-list")).toHaveCount(0);
  });

  test("サムネイル作成とページ並べ替えは、直接開いても単独で使える", async ({
    page,
  }) => {
    // Arrange - 整理を通さずに用意した 1 冊
    const archive = writeArchive(sidecar.workDir, "単独利用.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
      { name: "003.jpg", color: "#0000ff" },
    ]);

    // Act - サムネイル作成を直接開く
    await openMode(page, "thumbnail");

    // Assert - 受け渡しの一覧は目に入らず、今までどおりの入口が出る
    await expect(page.getByTestId("dropzone")).toBeVisible();
    await expect(page.getByTestId("open-browser")).toBeVisible();
    await expect(page.getByTestId("produced-item")).toHaveCount(0);

    // Act / Assert - 単独で最後まで使える
    await chooseArchiveViaBrowser(page, archive);
    await expect(page.getByTestId("thumbnail-archive-name")).toHaveText(
      "単独利用.zip",
    );
    await expect(page.getByTestId("cover-name")).toHaveText("001.jpg");

    // Act - ページ並べ替えを直接開く
    await openMode(page, "reorder");

    // Assert
    await expect(page.getByTestId("dropzone")).toBeVisible();
    await expect(page.getByTestId("open-browser")).toBeVisible();
    await expect(page.getByTestId("produced-item")).toHaveCount(0);

    // Act / Assert
    await chooseArchiveViaBrowser(page, archive);
    await expect(page.getByTestId("reorder-archive-name")).toHaveText(
      "単独利用.zip",
    );
    await expect(page.getByTestId("page-card")).toHaveCount(3);
  });
});

/**
 * 整理の途中で起きた失敗の見え方（#62）。
 *
 * process_single_archive() は処理中の例外を握りつぶすので、投入した全件が
 * 失敗してもジョブは succeeded で終わり、produced が空になる。画面はこれを
 * 「0 冊を整理しました」と読み替えてしまい、失敗と「対象が 0 件だった」の
 * 区別が付かない。
 */
test.describe("整理の失敗", () => {
  /** 中身が ZIP ではないファイル。展開の段で必ず失敗する */
  function writeBrokenArchive(name: string): string {
    const target = join(sidecar.workDir, name);
    writeFileSync(target, "これは ZIP ではない");
    return target;
  }

  /** 中身のある正常なアーカイブ */
  function writeGoodArchive(name: string): string {
    return writeArchive(sidecar.workDir, name, [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
    ]);
  }

  type Failure = { archive: string; reason: string };

  /**
   * 整理を実行し、サイドカーが記録したジョブをそのまま読む。
   *
   * 画面の文言ではなく、投入したジョブの結果を直接見る。何が失敗したかは
   * 環境で文字列が変わりうるので、期待値をテストに書き写さず API から取る。
   */
  async function organizeAndReadJob(page: Page) {
    const submitted = page.waitForResponse(
      (response) =>
        response.url().includes("/api/jobs/organize") &&
        response.request().method() === "POST",
    );
    await page.getByTestId("confirm").click();
    const { id } = (await (await submitted).json()) as { id: string };

    // 実行中だけ出るボタンが消えるまで待つ。終わったことを状態の文言で
    // 判定すると、文言を変えるだけでテストの意味が変わってしまう
    await expect(page.getByTestId("cancel")).toHaveCount(0, {
      timeout: 30_000,
    });

    const response = await fetch(
      `${sidecar.baseUrl}/api/jobs/${id}?token=${sidecar.token}`,
    );
    return (await response.json()) as {
      state: string;
      result: { produced?: string[]; failed?: Failure[] } | null;
    };
  }

  /** ジョブの結果から失敗の内訳を取り出す。無ければそこで落とす */
  function readFailures(job: {
    result: { failed?: Failure[] } | null;
  }): Failure[] {
    const failed = job.result?.failed;
    expect(
      failed,
      `ジョブの結果に failed が無い: ${JSON.stringify(job.result)}`,
    ).toBeDefined();
    return failed!;
  }

  /**
   * 処理ログを畳む。
   *
   * ログは既定で開いていて、失敗の行をそのまま含んでいる。畳まずに測ると
   * 「理由が画面に出ている」は最初から成り立ってしまい、何も実装しなくても
   * 通る。畳んだ状態で何が見えるかが「処理ログを開かなくても気づける」の
   * 測り方になる。どこにどう出すかは縛らない。
   */
  async function collapseLog(page: Page) {
    const log = page.getByTestId("organize-log");
    await expect(log).toBeVisible();
    await page.getByRole("button", { name: "処理ログ" }).click();
    await expect(log).toBeHidden();
  }

  /** 画面に見えている文字列のうち、その語を含むもの */
  function visible(page: Page, text: string) {
    return page.getByText(text, { exact: false }).filter({ visible: true });
  }

  /**
   * 「どのファイルが、なぜ失敗したか」が一緒に見えている箇所を数える。
   *
   * 対象ファイルの名前は処理対象の一覧にも出ているので、名前だけを探すと
   * 実装しなくても見つかってしまう。名前と理由が同じ小さな箱に収まって
   * いることを条件にする。畳んだログの文字列は textContent には残るため、
   * ログとログを内側に含む祖先は数えない。
   *
   * 理由は API が返した reason をそのまま照合する。文言をテストに書き写すと
   * 環境で変わる文字列を固定してしまうため。出し方（行・箇条書き・注意書き）
   * と置き場所は問わない。
   */
  async function failureSpots(page: Page, name: string, reason: string) {
    return page.evaluate(
      ({ name, reason, limit }) => {
        const log = document.querySelector('[data-testid="organize-log"]');
        const found: string[] = [];
        for (const element of Array.from(
          document.querySelectorAll<HTMLElement>("body *"),
        )) {
          if (log && (log === element || log.contains(element))) continue;
          if (log && element.contains(log)) continue;
          const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
          if (!text.includes(name) || !text.includes(reason)) continue;
          if (text.length > limit) continue;
          if (
            !element.checkVisibility({
              contentVisibilityAuto: true,
              opacityProperty: true,
              visibilityProperty: true,
            })
          ) {
            continue;
          }
          found.push(text);
        }
        return found;
      },
      { name, reason, limit: 300 },
    );
  }

  /** 失敗した各件について、名前と理由が一緒に見えていることを確かめる */
  async function expectFailuresVisible(page: Page, failures: Failure[]) {
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      const name = failure.archive.split(/[\\/]/).pop()!;
      await expect
        .poll(
          async () => (await failureSpots(page, name, failure.reason)).length,
          {
            message:
              `「${name}」と、その理由「${failure.reason}」が` +
              "処理ログの外で一緒に見えていない",
            timeout: 5_000,
          },
        )
        .toBeGreaterThan(0);
    }
  }

  test("全件失敗したときに、整理できたかのような文言を出さない", async ({
    page,
  }) => {
    // Arrange - 中身が ZIP ではない 2 冊。投入は通り、実行中に必ず失敗する
    const paths = [
      writeBrokenArchive("全件失敗A.zip"),
      writeBrokenArchive("全件失敗B.zip"),
    ];
    const output = join(sidecar.workDir, "out-all-failed");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await fillMangaInfo(page, "全件失敗する作品", "全件失敗の著者");
    await selectArchives(page, paths);

    // Act
    const job = await organizeAndReadJob(page);

    // Assert - 前提の確認。ジョブは走り切り、1 冊も出来ていない
    expect(job.state).toBe("succeeded");
    expect(job.result?.produced ?? []).toEqual([]);
    expect(producedFiles(output)).toEqual([]);

    // Assert - 成功の文言を出さない。「0 冊を整理しました」もこれに当たる
    await expect(page.getByTestId("organize-status")).not.toContainText(
      "整理しました",
    );

    // Assert - 失敗したことが伝わる。文言を変えただけでは足りないので、
    // 処理ログを畳んだ状態で理由が残っていることまで見る
    const failures = readFailures(job);
    await collapseLog(page);
    await expect
      .poll(async () => visible(page, failures[0].reason).count(), {
        message: `失敗の理由「${failures[0].reason}」が画面に出ていない`,
        timeout: 5_000,
      })
      .toBeGreaterThan(0);
  });

  test("失敗した理由が、処理ログを開かずに、どのファイルのものか分かる形で見える", async ({
    page,
  }) => {
    // Arrange - 失敗の理由が別々に出ることを見たいので 2 冊とも失敗させる
    const paths = [
      writeBrokenArchive("理由A.zip"),
      writeBrokenArchive("理由B.zip"),
    ];
    const output = join(sidecar.workDir, "out-failure-reason");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await fillMangaInfo(page, "理由が出る作品", "理由が出る著者");
    await selectArchives(page, paths);

    // Act
    const job = await organizeAndReadJob(page);
    const failures = readFailures(job);

    // Assert - 投入した 2 冊ぶんの理由がある
    expect(failures).toHaveLength(2);
    await collapseLog(page);

    // Assert - 名前と理由が組になって見えている。名前だけなら処理対象の
    // 一覧にも出ているので、理由と一緒であることが条件
    await expectFailuresVisible(page, failures);
  });

  test("一部だけ失敗したとき、出来たぶんと失敗したぶんの両方が見える", async ({
    page,
  }) => {
    // Arrange - 正常な 2 冊と、中身が ZIP ではない 2 冊
    const good = [
      writeGoodArchive("一部失敗_正常01.zip"),
      writeGoodArchive("一部失敗_正常02.zip"),
    ];
    const broken = [
      writeBrokenArchive("一部失敗_壊れA.zip"),
      writeBrokenArchive("一部失敗_壊れB.zip"),
    ];
    const output = join(sidecar.workDir, "out-partial-failed");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await fillMangaInfo(page, "一部失敗する作品", "一部失敗の著者");
    await selectArchives(page, [...good, ...broken]);

    // Act
    const job = await organizeAndReadJob(page);

    // Assert - 出来たぶんは今までどおり数と名前で見える
    const produced = producedNames(output);
    expect(produced).toHaveLength(2);
    await expect(page.getByTestId("produced-item")).toHaveCount(2);
    await expect(page.getByTestId("produced-name")).toHaveText(produced);

    // Assert - 失敗したぶんも、件数が分かる形で並ぶ。2 件を 1 行に
    // まとめて数を伏せる実装は、片方が見つからずここで落ちる
    const failures = readFailures(job);
    expect(failures).toHaveLength(2);
    await collapseLog(page);
    await expectFailuresVisible(page, failures);
  });

  test("全件失敗したときは、出来たファイルの一覧に何も出ない", async ({
    page,
  }) => {
    // Arrange - 先に成功させておく。失敗しても produced が空なだけなので、
    // 何も出来ていない状態から失敗させるのでは「一覧が出ない」は最初から
    // 成り立ってしまう。前回の一覧が残らないことまで見る
    const good = [
      writeGoodArchive("一覧_正常01.zip"),
      writeGoodArchive("一覧_正常02.zip"),
    ];
    // 2 回目に選ぶぶんもここで作る。ファイルブラウザの一覧は画面を開いた
    // ときのものなので、後から作ったファイルは選べない
    const broken = [
      writeBrokenArchive("一覧_壊れA.zip"),
      writeBrokenArchive("一覧_壊れB.zip"),
    ];
    const output = join(sidecar.workDir, "out-failed-list");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await fillMangaInfo(page, "一覧が消える作品", "一覧が消える著者");
    await selectArchives(page, good);
    await organizeAndReadJob(page);
    await expect(page.getByTestId("produced-item")).toHaveCount(2);
    const before = producedFiles(output);
    expect(before).toHaveLength(2);

    // Act - 対象を入れ替えて、全件失敗する実行をもう一度行う
    await page.getByTestId("clear-selection").click();
    await expect(page.getByTestId("selected-count")).toHaveText("0 件");
    await selectArchives(page, broken);
    const job = await organizeAndReadJob(page);

    // Assert - 出来たものは増えていない
    expect(producedFiles(output)).toEqual(before);

    // Assert - 失敗した件を「出来たファイル」として並べない。前回ぶんも残らない
    await expect(page.getByTestId("produced-item")).toHaveCount(0);
    await expect(page.getByTestId("produced-list")).toHaveCount(0);

    // Assert - そのうえで、失敗したことは理由付きで見えている。
    // 一覧が消えるだけでは、何も起きなかったのと区別が付かない
    const failures = readFailures(job);
    await collapseLog(page);
    await expectFailuresVisible(page, failures);
  });
});
