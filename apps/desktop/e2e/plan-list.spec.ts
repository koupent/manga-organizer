import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * 解析結果を 3 階層のリストで見せ、チェックボックスで選ぶ（#70 第 3 段階）。
 *
 * 第 1 段階でフォルダを丸ごと投入できるようになり、第 2 段階で「展開せずに
 * 目次を読んで出来上がる本を推定する」コア層が出来た。どちらも画面には
 * 繋がっていない。ここでは利用者の要望
 *
 *   「最終的にできる ZIP はこれ、みたいなので明示してあって」
 *   「もともとは全部チェックが入っていて、ユーザーがマニュアルでそのチェックを
 *     外すことで整形対象から外す」
 *
 * を画面の側から確かめる。ワイヤーフレームは `.sandbox/organize-input-mockup.html`
 * の「案 Z / Z-2 全段に三態」。
 *
 * ここで求める画面の契約は次のとおり。
 *
 * - `plan-list`  … 3 階層の一覧そのもの
 * - `plan-row`   … 一覧の 1 行。属性で中身が読める
 *     - `data-kind`        : folder | archive | book
 *     - `data-level`       : 階層の深さ。放り込んだものが 0
 *     - `data-path`        : フォルダ・アーカイブの行の、ディスク上の絶対パス
 *     - `data-source`      : 本の行の、元になったアーカイブの絶対パス
 *     - `data-entry`       : 本の行の、アーカイブ内での位置（全体で 1 冊なら空）
 *     - `data-output-name` : 本の行の、出来上がるファイル名
 *     - `data-issues`      : 実行前に見せる印。空白区切り。無ければ空
 * - `plan-check`        … 各行のチェック。三態は aria-checked の true / false / mixed
 * - `plan-master-check` … 主操作の行に置く、全体の三態チェック
 * - `plan-issue-chip`   … 主操作の行に出す印の件数（`data-issue` で種類）
 * - `organize-status`   … 「N 冊を作ります · M 冊を外した」
 *
 * 途中経過（実行中に行が育つ / #68）と RAR・7z の目次読みは第 4・第 5 段階なので
 * ここでは扱わない。API 側の契約は `services/core/tests/test_plan_selection.py`。
 */

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => sidecar?.stop());

/** 著者は全部のテストで共通。作品名だけ、テストごとに変える */
const AUTHOR = "テスト著者";

/** 解析中を捉えるために、解析の投入をわざと遅くする幅 */
const ANALYZE_DELAY_MS = 2_500;

/** 出来上がるはずのファイル名。組み立て方は VolumeDetector と同じ */
function volumeName(title: string, volume: number): string {
  return `[${AUTHOR}] ${title} 第${String(volume).padStart(3, "0")}巻.zip`;
}

/** 巻数が読めなかった本の名前 */
function unknownName(title: string): string {
  return `[${AUTHOR}] ${title} Unknown.zip`;
}

/** 出力先に実際に出来たファイルの名前 */
function producedNames(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .map((entry) => entry.split("/").pop()!)
      .filter((name) => name.endsWith(".zip"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 解析の対象になるフォルダを作る。
 *
 * - `合本.zip`    … 中に 第01巻/ と 第02巻/ があり、1 つの ZIP から 2 冊出る
 * - `単体_03.zip` … 全体で 1 冊
 *
 * アーカイブの件数（2）と出来上がる冊数（3）をわざと食い違わせる。落とした
 * ものをそのまま並べ直しただけの一覧では、この数が合わない。
 */
function makeFolder(name: string): {
  folder: string;
  compound: string;
  single: string;
} {
  const folder = join(sidecar.workDir, name);
  mkdirSync(folder, { recursive: true });
  const compound = writeArchive(sidecar.workDir, join(name, "合本.zip"), [
    { name: "第01巻/001.jpg", color: "#ff0000" },
    { name: "第01巻/002.jpg", color: "#ff8800" },
    { name: "第02巻/001.jpg", color: "#00ff00" },
    { name: "第02巻/002.jpg", color: "#00ff88" },
  ]);
  const single = writeArchive(sidecar.workDir, join(name, "単体_03.zip"), [
    { name: "001.jpg", color: "#0000ff" },
    { name: "002.jpg", color: "#0088ff" },
  ]);
  return { folder, compound, single };
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

/** 外部検索を「候補なし」に固定する。著者の補完はここでは見ない */
async function stubNoSuggestions(page: Page) {
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ author: null, candidates: [] }),
    }),
  );
}

/** 作品名と著者を入れる。作品名を変えると著者が引き直されるので、著者は後 */
async function fillMangaInfo(page: Page, title: string, author = AUTHOR) {
  await stubNoSuggestions(page);
  await page.getByTestId("organize-title").fill(title);
  await page.getByTestId("organize-author").fill(author);
  await expect(page.getByTestId("organize-author")).toHaveValue(author);
}

/** ファイル参照から、フォルダを丸ごと 1 回で投入する（第 1 段階の経路） */
async function addFolder(page: Page, folderName: string) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  await page
    .locator(`[data-testid="browse-entry"][data-name="${folderName}"]`)
    .getByRole("button", { name: "フォルダごと追加" })
    .click();
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeHidden();
}

/** ファイル参照から、単体のアーカイブを 1 つ投入する */
async function addArchive(page: Page, archiveName: string) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  await page
    .locator(
      `[data-testid="browse-entry"][data-name="${archiveName}"] .browser-name`,
    )
    .click();
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeHidden();
}

/** 一覧の 1 行を読み取った形 */
type PlanRow = {
  kind: string;
  level: number;
  path: string;
  source: string;
  entry: string;
  outputName: string;
  issues: string[];
};

/** 一覧の行を、上から順に読み取る */
async function readRows(page: Page): Promise<PlanRow[]> {
  const rows = await page.getByTestId("plan-row").all();
  return Promise.all(
    rows.map(async (row) => ({
      kind: (await row.getAttribute("data-kind")) ?? "",
      level: Number((await row.getAttribute("data-level")) ?? "-1"),
      path: (await row.getAttribute("data-path")) ?? "",
      source: (await row.getAttribute("data-source")) ?? "",
      entry: (await row.getAttribute("data-entry")) ?? "",
      outputName: (await row.getAttribute("data-output-name")) ?? "",
      issues: ((await row.getAttribute("data-issues")) ?? "")
        .split(/\s+/)
        .filter(Boolean),
    })),
  );
}

/** 本の行 */
function bookRow(page: Page, outputName: string): Locator {
  return page.locator(
    `[data-testid="plan-row"][data-kind="book"][data-output-name="${outputName}"]`,
  );
}

/** アーカイブの行 */
function archiveRow(page: Page, path: string): Locator {
  return page.locator(
    `[data-testid="plan-row"][data-kind="archive"][data-path="${path}"]`,
  );
}

/** フォルダの行 */
function folderRow(page: Page, path: string): Locator {
  return page.locator(
    `[data-testid="plan-row"][data-kind="folder"][data-path="${path}"]`,
  );
}

/** 行のチェック */
function checkOf(row: Locator): Locator {
  return row.getByTestId("plan-check");
}

/** 本の行が出そろうまで待つ。解析は往復を挟むので、待たずに読むと空になる */
async function waitForBooks(page: Page, count: number) {
  await expect(
    page.locator('[data-testid="plan-row"][data-kind="book"]'),
    "解析した本が一覧に出ていない",
  ).toHaveCount(count, { timeout: 30_000 });
}

/** 投入 → 解析まで済ませた状態を作る */
async function preparePlan(page: Page, name: string, title: string) {
  const output = join(sidecar.workDir, `out-${name}`);
  mkdirSync(output, { recursive: true });
  const made = makeFolder(name);
  await openOrganize(page, output);
  await fillMangaInfo(page, title);
  await addFolder(page, name);
  await waitForBooks(page, 3);
  return { ...made, output, title };
}

test.describe("解析した本の一覧", () => {
  test("フォルダを投入すると、フォルダ・アーカイブ・本の 3 階層で並ぶ", async ({
    page,
  }) => {
    // Arrange / Act
    const title = "三階層の作品";
    const { folder, compound, single } = await preparePlan(
      page,
      "三階層",
      title,
    );

    // Assert - 放り込んだフォルダ、その中で見つかったアーカイブ、
    // そこから出来上がる本が、それぞれ行として見える
    const rows = await readRows(page);
    const folders = rows.filter((row) => row.kind === "folder");
    const archives = rows.filter((row) => row.kind === "archive");
    const books = rows.filter((row) => row.kind === "book");

    expect(
      folders.map((row) => row.path),
      `放り込んだフォルダの行が無い: ${JSON.stringify(rows)}`,
    ).toEqual([folder]);
    expect(
      archives.map((row) => row.path).sort(),
      `見つかったアーカイブの行が揃っていない: ${JSON.stringify(rows)}`,
    ).toEqual([compound, single].sort());
    expect(
      books.map((row) => row.outputName).sort(),
      `出来上がる本の行が揃っていない: ${JSON.stringify(rows)}`,
    ).toEqual(
      [volumeName(title, 1), volumeName(title, 2), volumeName(title, 3)].sort(),
    );

    // Assert - 3 つは同じ深さに並んでいない。平らな一覧に data-kind を
    // 足しただけでは 3 階層とは言えない
    expect(Math.min(...archives.map((row) => row.level))).toBeGreaterThan(
      folders[0].level,
    );
    expect(Math.min(...books.map((row) => row.level))).toBeGreaterThan(
      Math.max(...archives.map((row) => row.level)),
    );

    // Assert - 本の行は、自分の元になったアーカイブの下に続く
    let grouped = 0;
    for (const [index, row] of rows.entries()) {
      if (row.kind !== "archive") continue;
      const children: PlanRow[] = [];
      for (let next = index + 1; rows[next]?.kind === "book"; next += 1) {
        children.push(rows[next]);
      }
      grouped += children.length;
      expect(
        [...new Set(children.map((child) => child.source))],
        `${row.path} の下に、別のアーカイブの本が混ざっている`,
      ).toEqual([row.path]);
    }
    expect(grouped, "どのアーカイブにも属さない本の行がある").toBe(
      books.length,
    );

    // Assert - 1 つの ZIP から出た 2 冊は、位置で区別できる
    const inside = books.filter((row) => row.source === compound);
    expect(inside).toHaveLength(2);
    expect(inside[0].entry).not.toBe(inside[1].entry);
  });

  test("主操作の行が一覧の直上にある", async ({ page }) => {
    // Arrange / Act
    await preparePlan(page, "直上", "直上の作品");

    // Assert - 一覧と主操作が同じ列にあり、主操作が一覧より上にある。
    // 左の設定列の底に置いたままでは「一覧の直上」ではない
    const list = page.getByTestId("plan-list");
    await expect(list).toBeVisible();
    const listBox = (await list.boundingBox())!;
    const confirm = (await page.getByTestId("confirm").boundingBox())!;
    expect(confirm.y + confirm.height).toBeLessThanOrEqual(listBox.y + 1);
    expect(confirm.x + confirm.width).toBeGreaterThan(listBox.x);
    expect(confirm.x).toBeLessThan(listBox.x + listBox.width);

    // Assert - 全体のチェックと状態が、主操作と同じ 1 行に収まる
    const master = (await page.getByTestId("plan-master-check").boundingBox())!;
    const status = (await page.getByTestId("organize-status").boundingBox())!;
    expect(master.x, "全体のチェックが主操作の左端に無い").toBeLessThan(
      confirm.x,
    );
    for (const [label, box] of [
      ["全体のチェック", master],
      ["状態", status],
    ] as const) {
      expect(box.y, `${label} が主操作と同じ行にない`).toBeLessThan(
        confirm.y + confirm.height,
      );
      expect(
        box.y + box.height,
        `${label} が主操作と同じ行にない`,
      ).toBeGreaterThan(confirm.y);
    }
  });

  test("既定では全部にチェックが入っている", async ({ page }) => {
    // Arrange / Act
    await preparePlan(page, "既定オン", "既定オンの作品");

    // Assert - フォルダ・アーカイブ・本のどの段にもチェックがあり、全部オン
    const rows = page.getByTestId("plan-row");
    const checks = page.getByTestId("plan-check");
    const rowCount = await rows.count();
    expect(rowCount, "一覧に行が無い").toBeGreaterThanOrEqual(6);
    await expect(checks, "チェックが無い段がある").toHaveCount(rowCount);
    for (let index = 0; index < rowCount; index += 1) {
      await expect(
        checks.nth(index),
        `${index} 行目が既定でオンになっていない`,
      ).toHaveAttribute("aria-checked", "true");
    }

    // Assert - 主操作の行の全体チェックもオン
    await expect(page.getByTestId("plan-master-check")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("本のチェックを外すと、その上の行が三態になる", async ({ page }) => {
    // Arrange
    const title = "三態の作品";
    const { folder, compound, single } = await preparePlan(page, "三態", title);

    // Act - 2 冊入りの ZIP から出る 2 冊目だけを外す
    await checkOf(bookRow(page, volumeName(title, 2))).click();

    // Assert - 外した本はオフ、兄弟はオンのまま
    await expect(checkOf(bookRow(page, volumeName(title, 2)))).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(checkOf(bookRow(page, volumeName(title, 1)))).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // Assert - 一部だけ外れた親は「一部」。全部オフにしてしまう実装で通らない
    await expect(
      checkOf(archiveRow(page, compound)),
      "一部だけ外したアーカイブが三態になっていない",
    ).toHaveAttribute("aria-checked", "mixed");
    await expect(
      checkOf(folderRow(page, folder)),
      "一部だけ外したフォルダが三態になっていない",
    ).toHaveAttribute("aria-checked", "mixed");
    await expect(page.getByTestId("plan-master-check")).toHaveAttribute(
      "aria-checked",
      "mixed",
    );

    // Assert - 関係のないアーカイブは巻き込まれない
    await expect(checkOf(archiveRow(page, single))).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // Assert - 外した行は消さずに薄く残す
    await expect(bookRow(page, volumeName(title, 2))).toBeVisible();
  });

  test("親のチェックを外すと下が全部外れる", async ({ page }) => {
    // Arrange
    const title = "親を外す作品";
    const { folder } = await preparePlan(page, "親を外す", title);
    const before = await page.getByTestId("plan-row").count();

    // Act - 放り込んだフォルダのチェックを外す
    await checkOf(folderRow(page, folder)).click();

    // Assert - 下のアーカイブも本も全部オフになる
    const checks = page.getByTestId("plan-check");
    const count = await checks.count();
    for (let index = 0; index < count; index += 1) {
      await expect(
        checks.nth(index),
        `${index} 行目が外れていない`,
      ).toHaveAttribute("aria-checked", "false");
    }
    await expect(page.getByTestId("plan-master-check")).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // Assert - 外した行は消えない。何を外したかが後で分かるようにする
    await expect(page.getByTestId("plan-row")).toHaveCount(before);
  });

  test("Shift を押しながら押すと、前に押した行からそこまでをまとめて切り替える（#158）", async ({
    page,
  }) => {
    // Arrange - 本の行を一覧に並んだ順で取る。間に入れ物の行が挟まってもよい
    await preparePlan(page, "範囲", "範囲の作品");
    const books = page.locator('[data-testid="plan-row"][data-kind="book"]');
    await expect(books).toHaveCount(3);
    const [first, second, third] = [0, 1, 2].map((index) =>
      checkOf(books.nth(index)),
    );

    // Act - 1 冊目を外してから、3 冊目を Shift で押す
    await first.click();
    await third.click({ modifiers: ["Shift"] });

    // Assert - 間の 2 冊目も外れる。押した 2 行だけを切り替える実装では残る
    for (const [label, check] of [
      ["1 冊目", first],
      ["2 冊目", second],
      ["3 冊目", third],
    ] as const) {
      await expect(check, `${label} が外れていない`).toHaveAttribute(
        "aria-checked",
        "false",
      );
    }

    // Act - 次は 3 冊目が起点になる。外れている 2 冊目を Shift で押すと付く方へそろう
    await second.click({ modifiers: ["Shift"] });

    // Assert - 2 冊目から 3 冊目までが付き、範囲の外の 1 冊目は外れたまま
    await expect(second).toHaveAttribute("aria-checked", "true");
    await expect(third).toHaveAttribute("aria-checked", "true");
    await expect(first).toHaveAttribute("aria-checked", "false");

    // Assert - Shift で押しても、一覧の文字が選ばれた状態にならない
    expect(await page.evaluate(() => String(window.getSelection()))).toBe("");
  });

  test("外した本は作られない", async ({ page }) => {
    // Arrange - 3 冊のうち、2 冊入り ZIP の 2 冊目だけを外す。アーカイブの
    // 単位でしか外せない実装では、この外し方が表現できない
    const title = "外した本の作品";
    const { output } = await preparePlan(page, "外した本", title);
    await checkOf(bookRow(page, volumeName(title, 2))).click();
    await expect(checkOf(bookRow(page, volumeName(title, 2)))).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // Act
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 60_000 },
    );

    // Assert - 外した 1 冊はディスクに出来ていない。見た目だけ外れて全部
    // 作られる実装はここで落ちる。残した 2 冊は出来ている
    expect(
      producedNames(output),
      "チェックを外した本が出力先に出来ている",
    ).toEqual([volumeName(title, 1), volumeName(title, 3)].sort());
  });

  test("主操作の行に、作る冊数と外した冊数が出る", async ({ page }) => {
    // Arrange / Act
    const title = "件数の作品";
    await preparePlan(page, "件数", title);

    // Assert - 押したら何が起きるかが 1 行で読める
    const status = page.getByTestId("organize-status");
    await expect(status).toContainText("3 冊を作ります");
    await expect(
      status,
      "何も外していないのに外した件数が出ている",
    ).not.toContainText("外した");

    // Act - 1 冊外す
    await checkOf(bookRow(page, volumeName(title, 2))).click();

    // Assert - 作る数が減り、外した数が出る
    await expect(status).toContainText("2 冊を作ります");
    await expect(status).toContainText("1 冊を外した");
  });

  test("巻数が読めない本に印が付き、主操作の行に件数が出る", async ({
    page,
  }) => {
    // Arrange - 名前に数字が無いアーカイブと、巻数が読めるアーカイブ
    const title = "印の作品";
    const name = "巻数の印";
    const output = join(sidecar.workDir, `out-${name}`);
    mkdirSync(output, { recursive: true });
    const folder = join(sidecar.workDir, name);
    mkdirSync(folder, { recursive: true });
    writeArchive(sidecar.workDir, join(name, "通常_01.zip"), [
      { name: "001.jpg", color: "#ff0000" },
    ]);
    writeArchive(sidecar.workDir, join(name, "特別編.zip"), [
      { name: "001.jpg", color: "#00ff00" },
    ]);

    // Act
    await openOrganize(page, output);
    await fillMangaInfo(page, title);
    await addFolder(page, name);
    await waitForBooks(page, 2);

    // Assert - 巻数が読めない本にだけ印が付く。全部に付けたら印の意味が無い
    await expect(bookRow(page, unknownName(title))).toHaveAttribute(
      "data-issues",
      /volume-unknown/,
    );
    await expect(
      bookRow(page, volumeName(title, 1)),
      "巻数が読めている本にまで印が付いている",
    ).toHaveAttribute("data-issues", "");

    // Assert - 主操作の行に件数のチップが出る
    const chip = page.locator(
      '[data-testid="plan-issue-chip"][data-issue="volume-unknown"]',
    );
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("1");

    // Act / Assert - その本を外せば、直せる問題ではなくなるので件数も消える
    await checkOf(bookRow(page, unknownName(title))).click();
    await expect(chip, "外した本の分まで数え続けている").toHaveCount(0);
  });

  test("左列で作品名を変えると、一覧の名前が変わる", async ({ page }) => {
    // Arrange - 1 冊だけ。名前の変化だけを見る
    const name = "名前の追従";
    const output = join(sidecar.workDir, `out-${name}`);
    mkdirSync(output, { recursive: true });
    const folder = join(sidecar.workDir, name);
    mkdirSync(folder, { recursive: true });
    writeArchive(sidecar.workDir, join(name, "通常_01.zip"), [
      { name: "001.jpg", color: "#ff0000" },
    ]);

    await openOrganize(page, output);
    await fillMangaInfo(page, "最初の作品");
    await addFolder(page, name);
    await waitForBooks(page, 1);
    await expect(bookRow(page, volumeName("最初の作品", 1))).toBeVisible();

    // Act - 作品名を変える。作品名を変えると著者は引き直されるので入れ直す
    await page.getByTestId("organize-title").fill("あとの作品");
    await page.getByTestId("organize-author").fill(AUTHOR);

    // Assert - 一覧の名前が追従する。落とし直しは要らない
    await expect(bookRow(page, volumeName("あとの作品", 1))).toBeVisible();
    await expect(
      bookRow(page, volumeName("最初の作品", 1)),
      "前の作品名のままの行が残っている",
    ).toHaveCount(0);
  });

  test("解析している間は主操作を押せない", async ({ page }) => {
    // Arrange - 「この内容で」の内容が揃うまで押させない。作品名と著者は
    // 先に埋めておき、未入力による無効と区別する
    const name = "解析中";
    const output = join(sidecar.workDir, `out-${name}`);
    mkdirSync(output, { recursive: true });
    makeFolder(name);
    await openOrganize(page, output);

    // 解析の投入だけを遅くする。解析はジョブになり、投入のあと状態を
    // 何度も取りに行くので、往復をまとめて遅らせるとフォルダの追加
    // （/api/browse）や毎回の問い合わせまで遅くなり、待ち時間が積み上がる
    await page.route("**/api/jobs/analyze*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, ANALYZE_DELAY_MS));
      await route.continue();
    });
    // 作品名と著者は先に埋める。未入力を理由にした無効と区別するため
    await fillMangaInfo(page, "解析中の作品");

    // Act
    await addFolder(page, name);

    // Assert - 解析が終わるまで押せない
    await expect(
      page.getByTestId("confirm"),
      "解析の途中なのに実行できてしまう",
    ).toBeDisabled();

    // Assert - 解析が終われば押せる。常に無効な実装で通らないようにする
    await waitForBooks(page, 3);
    await expect(page.getByTestId("confirm")).toBeEnabled();
  });

  test("並べ替えのグリップが無い", async ({ page }) => {
    // Arrange - 落としたものを 2 件にする。1 件だと今の実装も掴む所を
    // 出さないので、実装しなくても通ってしまう
    const name = "グリップ";
    const output = join(sidecar.workDir, `out-${name}`);
    mkdirSync(output, { recursive: true });
    makeFolder(name);
    writeArchive(sidecar.workDir, "グリップ単体_07.zip", [
      { name: "001.jpg", color: "#ff0000" },
    ]);

    // Act
    await openOrganize(page, output);
    await fillMangaInfo(page, "グリップの作品");
    await addFolder(page, name);
    await addArchive(page, "グリップ単体_07.zip");

    // Assert - フォルダを放り込む形になり、順番に意味が無くなった。
    // 掴む所は仕掛けごと出さない。飾りだけ残す実装も通らないようにする
    await expect(page.getByTestId("selected-grip")).toHaveCount(0);
    await expect(
      page.locator("svg.lucide-grip-vertical"),
      "掴めない飾りのグリップが残っている",
    ).toHaveCount(0);

    // Assert - 一覧そのものは出ている。空の画面を見て「無い」と言わない
    await waitForBooks(page, 4);
  });

  test("目次を読めないアーカイブに、目次を読めません の印が出る", async ({
    page,
  }) => {
    // Arrange - 読める ZIP と、ZIP の名前をした壊れたファイルを 1 つずつ。
    // 台本には差し替えない。印が出るかどうかは「サイドカーが読めなかったと
    // 言うか」で決まるので、作り物の応答を返すと確かめたことにならない
    const title = "壊れた作品";
    const name = "壊れている";
    const output = join(sidecar.workDir, `out-${name}`);
    mkdirSync(output, { recursive: true });
    const folder = join(sidecar.workDir, name);
    mkdirSync(folder, { recursive: true });
    const healthy = writeArchive(sidecar.workDir, join(name, "a_01.zip"), [
      { name: "001.jpg", color: "#0000ff" },
    ]);
    const corrupt = join(folder, "b_02.zip");
    writeFileSync(corrupt, "これは ZIP ではありません");

    // Act
    await openOrganize(page, output);
    await fillMangaInfo(page, title);
    await addFolder(page, name);
    await waitForBooks(page, 1);

    // Assert - 壊れたアーカイブの行は残ったまま、印が付く。第 4 段階から
    // 本を持たない入れ物も既定で選ばれて整理されるので、印が出なければ
    // 壊れたアーカイブは何の警告も無いまま実行に載る
    const broken = archiveRow(page, corrupt);
    await expect(broken, "壊れたアーカイブの行が無い").toHaveCount(1);
    await expect(
      broken,
      "目次を読めなかったのに、行に印が付いていない",
    ).toHaveAttribute("data-issues", /toc-unreadable/, { timeout: 30_000 });
    await expect(broken.getByTestId("plan-row-issue")).toHaveText(
      "目次を読めません",
    );

    // Assert - 対照。読めたアーカイブには付けない。全部に付ける実装では
    // 印そのものが意味を失う
    await expect(
      archiveRow(page, healthy),
      "読めているアーカイブにまで印が付いている",
    ).toHaveAttribute("data-issues", "");

    // Assert - 印は出るが、チェックは既定のまま。読めなかったことと
    // 「整理しない」ことは別で、中身は実行時に展開して初めて分かる
    await expect(checkOf(broken)).toHaveAttribute("aria-checked", "true");
  });

  test("解析した時点で出来上がる名前の順に並び、同じ巻が複数あれば数が出る（#162）", async ({
    page,
  }) => {
    // Arrange - 元の名前の順（a, dup, m, z）と出来上がる巻の順（1, 1, 2, 3）を
    // わざと食い違わせる。dup_01 と m_01 は同じ 1 巻
    const name = "名前順";
    const folder = join(sidecar.workDir, name);
    mkdirSync(folder, { recursive: true });
    const page1 = [{ name: "001.jpg", color: "#ff0000" }];
    for (const archive of ["a_02.zip", "dup_01.zip", "m_01.zip", "z_03.zip"])
      writeArchive(sidecar.workDir, join(name, archive), page1);
    const output = join(sidecar.workDir, "out-名前順");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    await fillMangaInfo(page, "名前順の作品");

    // Act
    await addFolder(page, name);
    await waitForBooks(page, 4);

    // Assert - 本は出来上がる名前（巻）の順。同じ巻どうしは隣り合う
    const books = page.locator('[data-testid="plan-row"][data-kind="book"]');
    const sources = await books.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-source")!.split("/").pop()),
    );
    expect(sources).toEqual(["dup_01.zip", "m_01.zip", "a_02.zip", "z_03.zip"]);

    // Assert - 同じ巻の 2 冊にだけ「同じ巻 2」が出る
    for (const [index, count] of [
      [0, "同じ巻 2"],
      [1, "同じ巻 2"],
    ] as const) {
      await expect(books.nth(index).getByTestId("plan-row-same")).toHaveText(
        count,
      );
    }
    await expect(books.nth(2).getByTestId("plan-row-same")).toHaveCount(0);
    await expect(books.nth(3).getByTestId("plan-row-same")).toHaveCount(0);

    // Act - 要らない方を外す
    await checkOf(books.nth(0)).click();

    // Assert - 外しても、同じ巻が他にもあることは見えたまま。重なりの警告は消える
    await expect(books.nth(0).getByTestId("plan-row-same")).toHaveText(
      "同じ巻 2",
    );
    await expect(books.nth(1).getByTestId("plan-row-issue")).toHaveCount(0);
  });

  test("アーカイブ全体が 1 冊の本には、ファイルの大きさが出る（#163）", async ({
    page,
  }) => {
    // Arrange / Act
    const title = "大きさの作品";
    await preparePlan(page, "大きさ", title);

    // Assert - 1 冊の ZIP は大きさが出る。2 冊入りの ZIP から出る本は、
    // 本ごとの大きさが分からないので空
    await expect(
      bookRow(page, volumeName(title, 3)).getByTestId("plan-row-size"),
    ).toHaveText(/^\d+(\.\d)? (B|KB)$/);
    for (const volume of [1, 2])
      await expect(
        bookRow(page, volumeName(title, volume)).getByTestId("plan-row-size"),
      ).toHaveText("");
  });

  test("本のファイルを、確かめてからごみ箱へ移せる（#164）", async ({
    page,
  }) => {
    // Arrange
    const title = "ごみ箱の作品";
    const { single } = await preparePlan(page, "ごみ箱", title);
    const row = bookRow(page, volumeName(title, 3));

    // Act - 行に乗せると出るボタンを押す
    await row.hover();
    await row.getByTestId("plan-trash").click();

    // Assert - 消す前に、名前と大きさを出して確かめる
    const dialog = page.getByTestId("trash-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("単体_03.zip（");
    await expect(dialog).toContainText(single);

    // Act / Assert - やめれば何も起きない
    await page.getByTestId("trash-cancel").click();
    await expect(dialog).toBeHidden();
    expect(existsSync(single)).toBe(true);
    await expect(row).toBeVisible();

    // Act - 今度は移す
    await row.hover();
    await row.getByTestId("plan-trash").click();
    await page.getByTestId("trash-confirm").click();

    // Assert - ファイルは元の場所から消え、一覧からも外れる。他の本は残る
    await expect(row).toHaveCount(0);
    expect(existsSync(single)).toBe(false);
    await expect(page.getByTestId("organize-status")).toContainText(
      "単体_03.zip をごみ箱へ移しました",
    );
    await expect(
      page.locator('[data-testid="plan-row"][data-kind="book"]'),
    ).toHaveCount(2);

    // Assert - 2 冊入りの ZIP から出る本は、その本だけを消せないのでボタンが無い
    const compoundBook = bookRow(page, volumeName(title, 1));
    await compoundBook.hover();
    await expect(compoundBook.getByTestId("plan-trash")).toHaveCount(0);
  });

  test("同じ巻は既定で大きい 1 冊だけを選び、外せば次、足せば両方を選んだ順の名前で作る（#166）", async ({
    page,
  }) => {
    // Arrange - 1 巻が 2 つ。大きいのは z_01（後に処理される方）
    const name = "重複選択";
    const folder = join(sidecar.workDir, name);
    mkdirSync(folder, { recursive: true });
    const pages = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        name: `${String(index + 1).padStart(3, "0")}.jpg`,
        color: "#336699",
      }));
    writeArchive(sidecar.workDir, join(name, "a_01.zip"), pages(1));
    writeArchive(sidecar.workDir, join(name, "z_01.zip"), pages(6));
    writeArchive(sidecar.workDir, join(name, "m_02.zip"), pages(1));
    const output = join(sidecar.workDir, "out-重複選択");
    mkdirSync(output, { recursive: true });
    await openOrganize(page, output);
    const title = "重複選択の作品";
    await fillMangaInfo(page, title);
    await addFolder(page, name);
    await waitForBooks(page, 3);
    const row = (source: string) =>
      page.locator(
        `[data-testid="plan-row"][data-kind="book"][data-source$="/${source}"]`,
      );

    // Assert - 1 巻は大きい z_01 だけが入り、番号なしの名前になる。2 巻は入る
    await expect(checkOf(row("z_01.zip"))).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(checkOf(row("a_01.zip"))).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(checkOf(row("m_02.zip"))).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(row("z_01.zip")).toHaveAttribute(
      "data-output-name",
      volumeName(title, 1),
    );
    await expect(page.getByTestId("organize-status")).toContainText(
      "2 冊を作ります",
    );

    // Act / Assert - 選ばれた z_01 を外すと、a_01 が代わりに選ばれる
    await checkOf(row("z_01.zip")).click();
    await expect(checkOf(row("z_01.zip"))).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(checkOf(row("a_01.zip"))).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // Act / Assert - a_01 も外せば、1 巻は 1 冊も作らない
    await checkOf(row("a_01.zip")).click();
    await expect(checkOf(row("a_01.zip"))).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(checkOf(row("z_01.zip"))).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // Act - z_01、a_01 の順に入れ直す
    await checkOf(row("z_01.zip")).click();
    await checkOf(row("a_01.zip")).click();

    // Assert - 足した a_01 で z_01 が外れず、両方残る。番号は選んだ順で、
    // 先に選んだ z_01 が番号なし、後から足した a_01 が _1
    await expect(checkOf(row("z_01.zip"))).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(checkOf(row("a_01.zip"))).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(row("z_01.zip")).toHaveAttribute(
      "data-output-name",
      volumeName(title, 1),
    );
    await expect(row("a_01.zip")).toHaveAttribute(
      "data-output-name",
      volumeName(title, 1).replace(".zip", "_1.zip"),
    );

    // Act - 整理する
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 30_000 },
    );

    // Assert - 出来たファイルの名前も予告どおり。処理した順（a_01 が先）で
    // 番号を付けると、ここが逆になる
    await expect(row("z_01.zip")).toHaveAttribute(
      "data-made",
      join(output, `[${AUTHOR}] ${title}`, volumeName(title, 1)),
    );
    await expect(row("a_01.zip")).toHaveAttribute(
      "data-made",
      join(
        output,
        `[${AUTHOR}] ${title}`,
        volumeName(title, 1).replace(".zip", "_1.zip"),
      ),
    );
  });
});
