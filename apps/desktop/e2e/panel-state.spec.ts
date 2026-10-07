import { openCoverTools } from "./cover-tools";
import { pageSizesOf } from "./archive";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

const CORE_DIR = fileURLToPath(
  new URL("../../../services/core", import.meta.url),
);

/**
 * 隠れている画面が黙っているか見張る幅。
 *
 * 別の画面にいる間の通信は、切り替えた瞬間ではなく少し経ってから出る。
 * 監視ややり直しが一巡するだけの間は留まってから数える。
 */
const WATCH_MS = 3_000;

/**
 * ページ並べ替えに並べる枚数。
 *
 * 窓に入り切らない量にする。img は loading="lazy" なので、入り切らない分は
 * 最初は取りに行かない。隠している間にその残りを取りに行く実装を捕まえる
 * には、取り残しがある状態で切り替える必要がある。
 */
const MANY_PAGES = 30;

/** 表示サイズの上限（PageGrid の可動域と同じ）。1 枚を大きく出して行数を稼ぐ */
const CARD_WIDTH_MAX = 520;

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => sidecar?.stop());

/** 画面を開く。接続情報はクエリ文字列で渡す */
/** 整理して出来た本の行（#160）。整理済みの印と、編集への近道が出る */
function madeRows(page: Page) {
  return page.locator('[data-testid="plan-row"][data-made]');
}

/** 出来上がった名前で引いた、整理して出来た本の行 */
function madeRow(page: Page, name: string) {
  return page.locator(
    `[data-testid="plan-row"][data-made][data-output-name="${name}"]`,
  );
}

/** 整理して出来た本の行の、出来上がった名前。並びは名前順にそろえる */
async function madeNames(page: Page): Promise<string[]> {
  const names = await madeRows(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-output-name") ?? ""),
  );
  return names.sort();
}

async function openApp(page: Page, params: Record<string, string>) {
  const query = new URLSearchParams({
    api: sidecar.baseUrl,
    token: sidecar.token,
    ...params,
  });
  await page.goto(`/?${query.toString()}`);
}

/** タブを押して画面を移る。押した先が選ばれたことまで見る */
async function switchMode(page: Page, mode: "organize" | "edit") {
  await page.getByTestId(`mode-${mode}`).click();
  await expect(page.getByTestId(`mode-${mode}`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/** 外部検索を見ないテストが AniList に出ていかないようにする */
async function stubNoSuggestions(page: Page) {
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ author: null, candidates: [] }),
    }),
  );
}

/** 作品名と著者を入れる */
async function fillMangaInfo(page: Page, title: string, author: string) {
  await stubNoSuggestions(page);
  await page.getByTestId("organize-title").fill(title);
  await page.getByTestId("organize-author").fill(author);
  await expect(page.getByTestId("organize-author")).toHaveValue(author);
}

/** ファイルブラウザから処理対象を選ぶ。実パスはサーバー側が返す */
async function selectArchives(page: Page, paths: string[]) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop()!;
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
  await expect(page.getByTestId("file-browser")).toBeHidden();
}

/**
 * 出力先に出来たファイルの、ファイル名だけを列挙する。
 *
 * 出来たファイルは `[著者] 作品名/` の下に置かれる。画面に出るのは
 * ファイル名なので、照合にはここを使う（organize.spec.ts と同じ）。
 */
function producedNames(root: string): string[] {
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
            print(path.name)
`,
      root,
    ],
    { cwd: CORE_DIR, encoding: "utf8" },
  );
  return output.trim() ? output.trim().split(/\r?\n/) : [];
}

/**
 * 巻数の違う 2 冊を作る。
 *
 * ページ数を 2 と 3 で変えるのは、受け渡した先で「どちらのファイルが
 * 読み込まれたか」を名前だけでなく中身からも見分けるため。
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

/**
 * 横長のページを持つ ZIP を作る。
 *
 * 2:3 でない寸法にするのは、枠に動かせる余りを作るため。ちょうど 2:3 だと
 * 初期状態の枠が画像いっぱいになり、掴んでも動かず何も試せない。
 */
function writeWideArchive(name: string): string {
  const target = join(sidecar.workDir, name);
  execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      `
import io, sys, zipfile
from PIL import Image
spread = Image.new("RGB", (1600, 1200), "#ff0000")
spread.paste(Image.new("RGB", (800, 1200), "#0000ff"), (800, 0))
buffer = io.BytesIO()
spread.save(buffer, "JPEG", quality=90)
page = io.BytesIO()
Image.new("RGB", (800, 1200), "#888888").save(page, "JPEG")
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("001.jpg", buffer.getvalue())
    archive.writestr("002.jpg", page.getvalue())
`,
      target,
    ],
    { cwd: CORE_DIR },
  );
  return target;
}

/** 画面に並んでいるページを、見えている順で読む */
function shownOrder(page: Page): Promise<(string | null)[]> {
  return page
    .getByTestId("editable-page")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-name")),
    );
}

/**
 * 画面を切り替えても、各機能の状態が残ることを見る。
 *
 * どれも「作りかけのまま別の画面を覗きに行き、戻って続ける」という使い方が
 * 成り立つかどうかを見ている。戻ったときに作り直されていれば落ちる。
 */
test.describe("画面を切り替えても状態が残る", () => {
  test("ファイル整理の入力は、サムネイル作成へ往復しても残る", async ({
    page,
  }) => {
    // Arrange - 整理の途中まで進めた状態を作る。
    // サムネイル作成が選び直しの画面にならないよう、対象も持たせておく
    const paths = writeVolumes("状態保持_入力");
    const cover = writeArchive(sidecar.workDir, "状態保持_入力_表紙.zip", [
      { name: "001.jpg", color: "#0000ff" },
    ]);
    const output = join(sidecar.workDir, "out-keep-input");
    mkdirSync(output, { recursive: true });
    await openApp(page, { mode: "organize", output, archive: cover });

    await fillMangaInfo(
      page,
      "往復しても消えない作品",
      "往復しても消えない著者",
    );
    await selectArchives(page, paths);

    // Act - サムネイル作成を覗いてから戻る
    await switchMode(page, "edit");
    await expect(page.getByTestId("editable-page").first()).toBeVisible();
    await switchMode(page, "organize");

    // Assert - 作品名と著者は入れたまま。ここが OrganizePanel の中の状態で、
    // 画面を作り直す実装では空に戻る
    await expect(page.getByTestId("organize-title")).toHaveValue(
      "往復しても消えない作品",
    );
    await expect(page.getByTestId("organize-author")).toHaveValue(
      "往復しても消えない著者",
    );

    // Assert - 処理対象も並んだまま。
    // なお処理対象と出力先は App が持つので、この 2 つだけでは落ちない。
    // 落ちるかどうかを決めているのは上の作品名と著者
    await expect(page.getByTestId("selected-count")).toHaveText("2 件");
    // 一覧は 3 階層になった（#70 第 3 段階）。落としたものは一番外側の行
    expect(
      await page
        .locator('[data-testid="source-row"]')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-path")),
        ),
    ).toEqual(paths);
    await expect(page.getByTestId("output-directory")).toHaveValue(output);
  });

  test("整理して出来た本の印は、サムネイル作成へ往復しても残る", async ({
    page,
  }) => {
    // Arrange - 最後まで走らせ、出来たファイルが並んだ状態を作る
    const paths = writeVolumes("状態保持_結果");
    const output = join(sidecar.workDir, "out-keep-produced");
    mkdirSync(output, { recursive: true });
    await openApp(page, { mode: "organize", output });

    await fillMangaInfo(page, "結果が消えない作品", "結果が消えない著者");
    await selectArchives(page, paths);
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 30_000 },
    );

    const expected = producedNames(output);
    expect(expected).toHaveLength(2);
    await expect(madeRows(page)).toHaveCount(2);
    expect(await madeNames(page)).toEqual([...expected].sort());

    // Act - 利用者が指摘した動き。出来た本の行からサムネイル作成へ
    // 移り、そこからファイル整理へ戻って次の作業を選ぼうとする
    await madeRow(page, expected[1]).getByTestId("plan-to-edit").click();
    await expect(page.getByTestId("archive-name")).toHaveText(expected[1]);
    await switchMode(page, "organize");

    // Assert - 出来た本の印はまだそこにある。
    // 戻った先が「待機中」の空の画面なら、次にどれを並べ替えるかを
    // 選び直す手がかりが無い
    await expect(madeRows(page)).toHaveCount(2);
    expect(await madeNames(page)).toEqual([...expected].sort());
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
    );
  });

  test("ページ並べ替えの途中経過は、ファイル整理へ往復しても残る", async ({
    page,
  }) => {
    // Arrange - 4 ページの ZIP を並べる
    const archive = writeArchive(
      sidecar.workDir,
      "状態保持_並べ替え.zip",
      ["#ff0000", "#00ff00", "#0000ff", "#ffff00"].map((color, index) => ({
        name: `00${index + 1}.jpg`,
        color,
      })),
    );
    await openApp(page, { mode: "reorder", archive });

    const cards = page.getByTestId("editable-page");
    await expect(cards).toHaveCount(4);
    await expect(page.getByTestId("split-confirm")).toHaveText(
      "確認済みにする",
    );

    // Act - 1 枚目を 3 枚目の位置へ運び、保存しないまま置いておく
    await cards.nth(0).getByTestId("page-drag-handle").hover();
    await page.mouse.down();
    const target = (await cards.nth(2).boundingBox())!;
    await page.mouse.move(
      target.x + target.width / 2,
      target.y + target.height / 2,
      { steps: 12 },
    );
    await page.mouse.up();

    await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");
    const edited = await shownOrder(page);
    expect(edited).not.toEqual(["001.jpg", "002.jpg", "003.jpg", "004.jpg"]);

    // Act - ファイル整理を覗いてから戻る。
    // dnd-kit はドラッグ終了から 50ms の間 click を止めるので、
    // 人が押すときと同じだけ間を空けてから押す
    await page.mouse.move(5, 5);
    await page.waitForTimeout(100);
    await switchMode(page, "organize");
    await expect(page.getByTestId("confirm")).toBeVisible();
    await switchMode(page, "edit");
    await expect(cards).toHaveCount(4);

    // Assert - 並べ替えた順序も、保存していないという印も残る
    expect(await shownOrder(page)).toEqual(edited);
    await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");

    // Assert - 取り消せる履歴も残る。戻った先で 1 手前に戻せなければ、
    // 途中経過を持ち越したとは言えない
    await expect(page.getByTestId("undo")).toBeEnabled();
    await page.getByTestId("undo").click();
    expect(await shownOrder(page)).toEqual([
      "001.jpg",
      "002.jpg",
      "003.jpg",
      "004.jpg",
    ]);
  });

  test("サムネイル画像調整の保留は、整理画面へ往復しても残る", async ({
    page,
  }) => {
    const archive = writeWideArchive("状態保持_表紙.zip");
    await openApp(page, { mode: "edit", archive });
    await openCoverTools(page);
    await page.getByTestId("rotate").click();
    await page.getByTestId("apply-thumbnail").click();
    await switchMode(page, "organize");
    await expect(page.getByTestId("confirm")).toBeVisible();
    await switchMode(page, "edit");
    await expect(page.getByTestId("split-status")).toContainText(
      "画像調整を反映します",
    );
    await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toHaveAttribute(
      "data-state",
      "done",
    );
    expect(pageSizesOf(archive)["001.jpg"]).toEqual([1200, 1800]);
  });

  /**
   * これだけは今の実装でも通る。今はモードを移ると PageGrid ごと捨てられ、
   * 取りに行く img が 1 つも残らないため。
   *
   * 意味を持つのはパネルを残す実装にした後。隠し方によっては、隠れたままの
   * 格子が残りのサムネイルを取りに行く（画面の外へ逃がす、透明にする、など
   * 描画が生きたままの隠し方はどれもそうなる）。ここはその回帰を止める番人で、
   * 実装より先に置いておく。
   */
  test("隠れているページ並べ替えは、ファイル整理にいる間サムネイルを取りに行かない", async ({
    page,
  }) => {
    // Arrange - 窓に入り切らない量を並べる。入り切らない分は lazy なので
    // まだ取りに行っていない。隠れている間にそれを取りに行けば数に出る
    const requested: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/thumb")) requested.push(request.url());
    });

    // Arrange - 1 枚を大きく表示する。既定の 160px では 60 枚並べても
    // Chromium の先読みが全部さらってしまい、取り残しが作れない。表示サイズは
    // 開く前から効くよう保存先に入れておく（利用者が前回動かした状態と同じ）
    await page.addInitScript((width) => {
      window.localStorage.setItem("manga-organizer:split.cardWidth", width);
    }, String(CARD_WIDTH_MAX));

    const archive = writeArchive(
      sidecar.workDir,
      "状態保持_通信.zip",
      Array.from({ length: MANY_PAGES }, (_, index) => ({
        name: `${String(index + 1).padStart(3, "0")}.jpg`,
        color: index % 2 === 0 ? "#ff0000" : "#0000ff",
      })),
    );
    await openApp(page, { mode: "reorder", archive });
    await expect(page.getByTestId("editable-page")).toHaveCount(MANY_PAGES);
    await expect(page.getByTestId("split-card-width")).toHaveValue(
      String(CARD_WIDTH_MAX),
    );

    // Arrange - 最初の読み込みが落ち着くまで待つ。ここまでの分は数えない
    let previous = -1;
    await expect
      .poll(
        () => {
          const settled = requested.length === previous;
          previous = requested.length;
          return settled;
        },
        {
          timeout: 30_000,
          intervals: [500],
          message: "サムネイルの読み込みが落ち着きません",
        },
      )
      .toBe(true);

    // Assert - 数え方が効いていること、かつ取り残しがあること。
    // 全部読み終わっていると、隠れている間に取りに行く実装でも 0 件になる
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.length).toBeLessThan(MANY_PAGES);
    const mark = requested.length;

    // Act - ファイル整理へ移り、しばらくそこに留まる
    await switchMode(page, "organize");
    await expect(page.getByTestId("confirm")).toBeVisible();
    await page.waitForTimeout(WATCH_MS);

    // Assert - 隠れている間は 1 件も取りに行かない
    expect(requested.slice(mark)).toEqual([]);

    // Assert - 戻れば再開する。止めたまま白いカードが並ぶのでは意味がない
    await switchMode(page, "edit");
    await expect(page.getByTestId("editable-page")).toHaveCount(MANY_PAGES);
    await expect(
      page.getByTestId("editable-page").first().locator("img"),
    ).toHaveJSProperty("naturalWidth", 600); // 元画像の幅まで取得する
  });
});
