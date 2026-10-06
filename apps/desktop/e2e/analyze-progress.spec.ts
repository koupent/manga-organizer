import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * 解析の途中経過を画面に出す（#70 第 4 段階）。
 *
 * 第 3 段階の解析は 1 往復で全部返るので、画面は「終わるまで空 → 突然そろう」
 * という見え方になる。数百 GB の蔵書では待つ時間が長く、受け付けられたのか
 * どうかも分からない。利用者の要望は
 *
 *   「解析中: 走査で行が先に全部並び、目次を読めた順に本の行が生えます。
 *     主操作は解析完了まで無効。チェックは解析中も付けられます」
 *
 * ここで求める画面の契約は次のとおり。行の属性そのものは第 3 段階
 * （`plan-list.spec.ts` の冒頭）と同じで、増えるのは中身の育ち方だけ。
 *
 * - 走査だけが終わった時点で、`plan-row[data-kind=archive]` が全部並ぶ。
 *   本の行はまだ 1 つも無い
 * - 本の行が後から生えても、その手前で外したアーカイブのチェックは
 *   引き継がれる（生えた本は最初から外れている）
 * - 投入を変えたら、走っていた解析ジョブを番号で名指しして止める
 *
 * 「後から生えた行の既定」は #73 段階 4b で 3 通りに分かれる。覚えるのは
 * 利用者が触った行だけになり、覚えた値が付け外しの 2 通りを持つようになる
 * ためで、上を外して下だけ入れ直した状態が表せるようになる。
 *
 * | 触り方 | 生えた本 |
 * |---|---|
 * | フォルダを外し、その中のアーカイブを入れ直す | そのアーカイブの本は入る |
 * | アーカイブを外しただけ | 外れたまま |
 * | 何も触らない | 整理済みなら外れる。それ以外は入る |
 *
 * 一番内側で触った行が勝つ。外側だけを見る（「先祖のどれかが外れていたら
 * 外す」）実装では 1 行目が表せない。
 *
 * **本物のサイドカーでは、この瞬間を狙って捉えられない。** 走査と目次読みの
 * 間隔はミリ秒で、遅らせても「たまたま捉えられた回」しか通らないテストになる。
 * ここでは `**\/api/jobs/**` を差し替え、局面を台本どおりに進める。台本の中身
 * （どんな結果が返るか）は `services/core/tests/test_analysis_progress.py` が
 * サイドカー側で固定する。
 */

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => sidecar?.stop());

/** 著者は全部のテストで共通 */
const AUTHOR = "テスト著者";

/** 台本が配るジョブ番号。投入された順に使う */
const JOB_IDS = ["analyze-job-1", "analyze-job-2", "analyze-job-3"];

/**
 * 解析ジョブが返す本 1 冊。サイドカーの PlannedBookView と同じ形。
 *
 * 欄を省くと、型の上では埋まっているのに実行時は `undefined` になる。
 * `data-organized="undefined"` はそうして出ていた。本ごとの名前（#73 段階 4a）
 * では `title` / `author` が「自分の名前を持つか」の判定に使われるので、
 * 省いた台本の本は「名前を持つ」側に落ちる。欄は 1 つも省かない。
 */
type Book = {
  source: string;
  entry: string;
  output_name: string;
  volume: number | null;
  issues: string[];
  organized: boolean;
  organized_reason: string | null;
  /** 本の名前から読んだ著者名。整理済みでなければ null */
  author: string | null;
  /** 本の名前から読んだ作品名。整理済みでなければ null */
  title: string | null;
};

/** 台本の 1 局面。`GET /api/jobs/{id}` が返す中身のうち、意味のある所だけ */
type Phase = {
  state: "running" | "succeeded";
  scanned: boolean;
  containers: string[];
  books: Book[];
  /** 目次を読み終えた入れ物の数。省くと本があれば 1、無ければ 0 */
  current?: number;
  /** いま読んでいる入れ物の進み（0〜1）（#157） */
  reading?: number;
};

/** 整理済みの本が持っている、自分の著者と作品名。左の列とはわざと違える */
const SHELF_AUTHOR = "棚の著者";
const SHELF_TITLE = "棚の作品";

/** 出来上がるはずのファイル名。組み立て方は VolumeDetector と同じ */
function volumeName(title: string, volume: number): string {
  return `[${AUTHOR}] ${title} 第${String(volume).padStart(3, "0")}巻.zip`;
}

/** 解析が返す本 1 冊を組み立てる */
function book(
  title: string,
  source: string,
  entry: string,
  volume: number,
): Book {
  return {
    source,
    entry,
    output_name: volumeName(title, volume),
    volume,
    issues: [],
    // 台本の本はどれも整理済みでない。ここで見るのは行の育ち方だけなので、
    // 判定は一番ありふれた姿（まだ整理していない蔵書）に固定する
    organized: false,
    organized_reason: "name-mismatch",
    author: null,
    title: null,
  };
}

/**
 * 解析が返す、**整理済みの**本 1 冊（#73 段階 4b）。
 *
 * `organized` を立てるだけでは足りない。整理済みの本は自分の名前を持って
 * 返るので、そこまで揃えないと「整理済みだが名前を持たない本」という、
 * サイドカーが返しえない姿を試すことになる。
 *
 * 名前は左の列（AUTHOR / title）とわざと違える。揃えると、自分の名前を
 * 使わず左の列で組み直す実装でも同じ名前が出てしまう。
 */
function organizedBook(source: string, volume: number): Book {
  return {
    source,
    entry: "",
    output_name:
      `[${SHELF_AUTHOR}] ${SHELF_TITLE} ` +
      `第${String(volume).padStart(3, "0")}巻.zip`,
    volume,
    issues: [],
    organized: true,
    // 整理済みに理由は無い。欄そのものは省かない
    organized_reason: null,
    author: SHELF_AUTHOR,
    title: SHELF_TITLE,
  };
}

/** `GET /api/jobs/{id}` の応答。JobDetail の形をそのまま埋める */
function jobBody(id: string, phase: Phase) {
  return {
    id,
    kind: "analyze",
    state: phase.state,
    current: phase.current ?? (phase.books.length > 0 ? 1 : 0),
    total: phase.scanned ? phase.containers.length : 0,
    message: "",
    result: {
      scanned: phase.scanned,
      containers: phase.containers,
      books: phase.books,
      unreadable: [],
      reading: phase.reading ?? 0,
    },
    error: null,
    created_at: "2026-01-01T00:00:00+00:00",
    updated_at: "2026-01-01T00:00:00+00:00",
    log: [],
  };
}

/** 差し替えた応答。オリジンが違うので、素通しできるよう明示する */
function asJson(status: number, payload: unknown) {
  return {
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(payload),
  };
}

type Script = {
  /** 投入された順のジョブ番号 */
  submitted: string[];
  /** 止めろと言われたジョブ番号 */
  cancelled: string[];
  /** 次の局面へ進める */
  advance: () => void;
};

/**
 * 解析ジョブの入口と状態取得を台本に差し替える。
 *
 * 整理ジョブ（`/api/jobs/organize`）は素通しする。ここで見たいのは解析だけで、
 * 実行の経路まで作り物にすると、通ったことの意味が薄くなる。
 */
async function scriptAnalysis(page: Page, phases: Phase[]): Promise<Script> {
  const script: Script = { submitted: [], cancelled: [], advance: () => {} };
  let index = 0;
  script.advance = () => {
    index = Math.min(index + 1, phases.length - 1);
  };

  await page.route("**/api/jobs/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path.endsWith("/api/jobs/analyze") && request.method() === "POST") {
      const id = JOB_IDS[script.submitted.length] ?? "analyze-job-extra";
      script.submitted.push(id);
      return route.fulfill(asJson(202, { id }));
    }
    if (path.endsWith("/cancel")) {
      script.cancelled.push(path.split("/").slice(-2)[0]!);
      return route.fulfill(asJson(202, { id: "cancelled" }));
    }
    const id = path.split("/").pop()!;
    if (!JOB_IDS.includes(id)) return route.continue();
    return route.fulfill(asJson(200, jobBody(id, phases[index]!)));
  });

  return script;
}

/**
 * 解析の対象になるフォルダを作る。
 *
 * - `合本.zip`    … 中に 第01巻/ と 第02巻/ があり、1 つの ZIP から 2 冊出る
 * - `単体_03.zip` … 全体で 1 冊
 *
 * 台本は作り物だが、パスは実在させる。ファイル参照から投入する経路は本物の
 * サイドカーを通るため、無いものは投入できない。
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
    { name: "第02巻/001.jpg", color: "#00ff00" },
  ]);
  const single = writeArchive(sidecar.workDir, join(name, "単体_03.zip"), [
    { name: "001.jpg", color: "#0000ff" },
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
    route.fulfill(asJson(200, { author: null, candidates: [] })),
  );
}

/** 作品名と著者を入れる。作品名を変えると著者が引き直されるので、著者は後 */
async function fillMangaInfo(page: Page, title: string) {
  await stubNoSuggestions(page);
  await page.getByTestId("organize-title").fill(title);
  await page.getByTestId("organize-author").fill(AUTHOR);
  await expect(page.getByTestId("organize-author")).toHaveValue(AUTHOR);
}

/** ファイル参照から、フォルダを丸ごと 1 回で投入する */
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

/** アーカイブの行 */
function archiveRow(page: Page, path: string): Locator {
  return page.locator(
    `[data-testid="plan-row"][data-kind="archive"][data-path="${path}"]`,
  );
}

/** ある入れ物から生えた本の行。名前は作品名で変わるので元のパスで指す */
function bookRowsOf(page: Page, source: string): Locator {
  return page.locator(
    `[data-testid="plan-row"][data-kind="book"][data-source="${source}"]`,
  );
}

/** 行のチェック */
function checkOf(row: Locator): Locator {
  return row.getByTestId("plan-check");
}

/** 一覧に出ている、種類ごとの行 */
function rowsOfKind(page: Page, kind: string): Locator {
  return page.locator(`[data-testid="plan-row"][data-kind="${kind}"]`);
}

/** 台本のとおりに解析ジョブが投入されるまで待つ */
async function waitForSubmission(script: Script, count: number) {
  await expect
    .poll(() => script.submitted.length, {
      message: "解析がジョブとして投入されていない",
      timeout: 15_000,
    })
    .toBe(count);
}

test.describe("解析の途中経過", () => {
  test("読んでいるアーカイブの名前・経過時間・中の進みが出る（#157）", async ({
    page,
  }) => {
    // Arrange - 2 つのうち 1 つ目の目次を半分まで読んだ局面
    const title = "進みの作品";
    const name = "進み";
    const output = join(sidecar.workDir, `out-${name}`);
    mkdirSync(output, { recursive: true });
    const { compound, single } = makeFolder(name);
    const script = await scriptAnalysis(page, [
      {
        state: "running",
        scanned: true,
        containers: [compound, single],
        books: [],
        current: 0,
        reading: 0.5,
      },
    ]);
    await openOrganize(page, output);
    await fillMangaInfo(page, title);

    // Act
    await addFolder(page, name);
    await waitForSubmission(script, 1);

    // Assert - 何を読んでいるかと経過時間を言う。件数が 0 のままでも、
    // 時間が進むので止まっていないと分かる
    const status = page.getByTestId("organize-status");
    await expect(status).toContainText("合本.zip を読んでいます");
    await expect(status).toContainText("経過 0:0");

    // Assert - 割合は、読んでいる途中の進みも含める（0 件 + 半分 / 2 件）
    await expect(page.getByTestId("progress-count")).toHaveText("0 / 2 · 25%");
    await expect(page.getByTestId("progress")).toHaveAttribute(
      "aria-valuenow",
      "25",
    );

    // Assert - 経過時間は進む
    await expect(status).toContainText("経過 0:02", { timeout: 5_000 });
  });

  test("走査が終わった時点で、アーカイブの行だけが並ぶ", async ({ page }) => {
    // Arrange - 走査だけが終わった局面。入れ物は出そろい、本はまだ 0 冊
    const title = "走査の作品";
    const name = "走査";
    const output = join(sidecar.workDir, `out-${name}`);
    mkdirSync(output, { recursive: true });
    const { compound, single } = makeFolder(name);
    const script = await scriptAnalysis(page, [
      {
        state: "running",
        scanned: true,
        containers: [compound, single],
        books: [],
      },
    ]);

    await openOrganize(page, output);
    await fillMangaInfo(page, title);

    // Act
    await addFolder(page, name);
    await waitForSubmission(script, 1);

    // Assert - 見つかった入れ物は全部行になる。走査の結果を渡さず本から
    // 行を起こす実装だと、ここは 0 行のまま何も出ない
    await expect(
      rowsOfKind(page, "archive"),
      "走査で見つかったアーカイブの行が並んでいない",
    ).toHaveCount(2);
    await expect(archiveRow(page, compound)).toBeVisible();
    await expect(archiveRow(page, single)).toBeVisible();
    await expect(rowsOfKind(page, "folder")).toHaveCount(0);

    // Assert - 本の行はまだ 1 つも無い。ここが 0 でないと「行が先に並ぶ」
    // ことを確かめたことにならない
    await expect(
      rowsOfKind(page, "book"),
      "目次を読む前なのに本の行が出ている",
    ).toHaveCount(0);

    // Assert - 解析が終わるまで主操作は押せない
    await expect(
      page.getByTestId("confirm"),
      "解析の途中なのに実行できてしまう",
    ).toBeDisabled();
  });

  test("解析中に外したアーカイブは、後から生えた本も外れたままになる", async ({
    page,
  }) => {
    // Arrange - A: 走査だけ / B: 合本の 2 冊が届く / C: 全部そろって完了
    const title = "引き継ぎの作品";
    const name = "引き継ぎ";
    const output = join(sidecar.workDir, `out-${name}`);
    mkdirSync(output, { recursive: true });
    const { compound, single } = makeFolder(name);
    const compoundBooks = [
      book(title, compound, "第01巻", 1),
      book(title, compound, "第02巻", 2),
    ];
    const singleBooks = [book(title, single, "", 3)];
    const containers = [compound, single];
    const script = await scriptAnalysis(page, [
      { state: "running", scanned: true, containers, books: [] },
      { state: "running", scanned: true, containers, books: compoundBooks },
      {
        state: "succeeded",
        scanned: true,
        containers,
        books: [...compoundBooks, ...singleBooks],
      },
    ]);

    await openOrganize(page, output);
    await fillMangaInfo(page, title);
    await addFolder(page, name);
    await waitForSubmission(script, 1);

    // Arrange - まだ本の行が 1 つも無いことを確かめてから外す。既にある
    // 本の行を外したのでは、今の実装のままでも通ってしまう
    await expect(rowsOfKind(page, "archive")).toHaveCount(2);
    await expect(
      bookRowsOf(page, compound),
      "外す前から本の行が生えている",
    ).toHaveCount(0);

    // Act - 本の行がまだ無いアーカイブのチェックを外す
    await checkOf(archiveRow(page, compound)).click();
    await expect(checkOf(archiveRow(page, compound))).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // Act - 目次が読めて、そのアーカイブの本が生える
    script.advance();

    // Assert - 生えた本は最初から外れている。外した覚えのない本が
    // 勝手に整理されるのが一番困る
    const grown = bookRowsOf(page, compound);
    await expect(grown).toHaveCount(2);
    for (const row of await grown.all()) {
      await expect(
        checkOf(row),
        "解析中に外したのに、後から生えた本にチェックが入っている",
      ).toHaveAttribute("aria-checked", "false");
    }
    await expect(page.getByTestId("plan-master-check")).toHaveAttribute(
      "aria-checked",
      "mixed",
    );

    // Act - 残りの目次も読み終わる
    script.advance();

    // Assert - 外していないアーカイブの本は入ったまま。「後から生えた本を
    // 全部外す」実装で通らないようにする
    const sibling = bookRowsOf(page, single);
    await expect(sibling).toHaveCount(1);
    await expect(checkOf(sibling.first())).toHaveAttribute(
      "aria-checked",
      "true",
    );
    for (const row of await bookRowsOf(page, compound).all()) {
      await expect(checkOf(row)).toHaveAttribute("aria-checked", "false");
    }
    await expect(page.getByTestId("plan-master-check")).toHaveAttribute(
      "aria-checked",
      "mixed",
    );
  });

  test("フォルダを外してアーカイブを入れ直すと、そのアーカイブの本だけが入る", async ({
    page,
  }) => {
    // Arrange - A: 走査だけ / B: 合本の 2 冊が届く / C: 全部そろって完了
    const title = "入れ直しの作品";
    const name = "入れ直し";
    const output = join(sidecar.workDir, `out-${name}`);
    mkdirSync(output, { recursive: true });
    const { compound, single } = makeFolder(name);
    const compoundBooks = [
      book(title, compound, "第01巻", 1),
      book(title, compound, "第02巻", 2),
    ];
    const singleBooks = [book(title, single, "", 3)];
    const containers = [compound, single];
    const script = await scriptAnalysis(page, [
      { state: "running", scanned: true, containers, books: [] },
      { state: "running", scanned: true, containers, books: compoundBooks },
      {
        state: "succeeded",
        scanned: true,
        containers,
        books: [...compoundBooks, ...singleBooks],
      },
    ]);

    await openOrganize(page, output);
    await fillMangaInfo(page, title);
    await addFolder(page, name);
    await waitForSubmission(script, 1);

    // Arrange - まだ本の行が 1 つも無いことを確かめてから触る。既にある
    // 本の行を触ったのでは、後から生えた行の既定を試したことにならない
    await expect(rowsOfKind(page, "archive")).toHaveCount(2);
    await expect(
      bookRowsOf(page, compound),
      "触る前から本の行が生えている",
    ).toHaveCount(0);

    // Act - フォルダごと外す
    await page.getByTestId("plan-master-check").click();
    await expect(page.getByTestId("plan-master-check")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(checkOf(archiveRow(page, compound))).toHaveAttribute(
      "aria-checked",
      "false",
    );

    // Act / Assert - その中の 1 つだけを入れ直す。上を外したことだけを見る
    // 実装では、入れ直しても外側が外れたままなので何も起きない
    await checkOf(archiveRow(page, compound)).click();
    await expect(
      checkOf(archiveRow(page, compound)),
      "入れ直したアーカイブが入っていない",
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      checkOf(archiveRow(page, single)),
      "入れ直していないアーカイブまで入っている",
    ).toHaveAttribute("aria-checked", "false");

    // Act - 目次が読めて、入れ直したアーカイブの本が生える
    script.advance();

    // Assert - 生えた本は入っている。上を外したことだけを見て下へ伝える
    // 実装（先祖のどれかが外れていたら外す）では、入れ直したはずの
    // アーカイブの本が外れて出てくる。利用者は入れ直した操作が何も
    // 効いていないように見える
    const grown = bookRowsOf(page, compound);
    await expect(grown).toHaveCount(2);
    for (const row of await grown.all()) {
      await expect(
        checkOf(row),
        "入れ直したアーカイブの本が、生えたときに外れている",
      ).toHaveAttribute("aria-checked", "true");
    }

    // Act - 残りの目次も読み終わる
    script.advance();

    // Assert - 対照。入れ直していないアーカイブの本は外れたまま。
    // 「触られた先祖が 1 つでもあれば入れる」実装で通らないようにする
    const sibling = bookRowsOf(page, single);
    await expect(sibling).toHaveCount(1);
    await expect(
      checkOf(sibling.first()),
      "入れ直していないアーカイブの本まで入っている",
    ).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("plan-master-check")).toHaveAttribute(
      "aria-checked",
      "mixed",
    );
  });

  test("何も触らなければ、後から生えた整理済みの本だけが外れる", async ({
    page,
  }) => {
    // Arrange - A: 走査だけ / B: 3 冊そろって完了。単体の 1 冊だけが整理済み
    const title = "既定の作品";
    const name = "既定";
    const output = join(sidecar.workDir, `out-${name}`);
    mkdirSync(output, { recursive: true });
    const { compound, single } = makeFolder(name);
    const containers = [compound, single];
    const script = await scriptAnalysis(page, [
      { state: "running", scanned: true, containers, books: [] },
      {
        state: "succeeded",
        scanned: true,
        containers,
        books: [
          book(title, compound, "第01巻", 1),
          book(title, compound, "第02巻", 2),
          organizedBook(single, 3),
        ],
      },
    ]);

    await openOrganize(page, output);
    await fillMangaInfo(page, title);
    await addFolder(page, name);
    await waitForSubmission(script, 1);
    await expect(rowsOfKind(page, "book")).toHaveCount(0);

    // Act - 何も触らずに、目次が読み終わるのを待つだけ
    script.advance();
    await expect(rowsOfKind(page, "book")).toHaveCount(3);

    // Assert - 前提。台本の本が本当に整理済みとして届いていること。
    // `organized: false` の台本で試すと、以下の主張はすべて空振りする
    const organized = bookRowsOf(page, single);
    await expect(
      organized,
      "台本の本が整理済みとして届いていない",
    ).toHaveAttribute("data-organized", "true");

    // Assert - 整理済みの本は、生えた時点で外れている。既定は行を組み直す
    // たびに導き直されるので、生えた行にも同じように効く
    await expect(
      checkOf(organized),
      "後から生えた整理済みの本が既定で入っている",
    ).toHaveAttribute("aria-checked", "false");

    // Assert - 対照。整理済みでない本は今までどおり入っている。
    // 「生えた本を全部外す」実装で通らないようにする
    const messy = bookRowsOf(page, compound);
    await expect(messy).toHaveCount(2);
    for (const row of await messy.all()) {
      await expect(
        checkOf(row),
        "整理済みでない本まで既定で外れている",
      ).toHaveAttribute("aria-checked", "true");
    }

    await expect(page.getByTestId("plan-master-check")).toHaveAttribute(
      "aria-checked",
      "mixed",
    );
    await expect(page.getByTestId("plan-master-check")).toHaveAttribute(
      "aria-checked",
      "mixed",
    );

    // Assert - 行は消えない。作らないことと、見つからなかったことは別
    await expect(
      page.getByTestId("plan-row"),
      "整理済みの行が一覧から消えている",
    ).toHaveCount(3);
  });

  test("投入を変えると、走っていた解析を番号で名指しして止める", async ({
    page,
  }) => {
    // Arrange - 解析は終わらない局面のまま。走っている最中に投入を変える
    const title = "止める作品";
    const first = "止める前";
    const second = "止めた後";
    const output = join(sidecar.workDir, "out-止める");
    mkdirSync(output, { recursive: true });
    const before = makeFolder(first);
    makeFolder(second);
    const script = await scriptAnalysis(page, [
      {
        state: "running",
        scanned: true,
        containers: [before.compound, before.single],
        books: [],
      },
    ]);

    // 送られた要求をそのまま控える。台本の側だけを見ると、差し替えを
    // すり抜けた要求（本物のサイドカーへ飛んだもの）を見落とす
    const posted: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      posted.push(new URL(request.url()).pathname);
    });

    await openOrganize(page, output);
    await fillMangaInfo(page, title);
    await addFolder(page, first);
    await waitForSubmission(script, 1);
    const firstJob = script.submitted[0]!;

    // Act - 投入を足す。解析は投入の中身が変わるたびにやり直す
    await addFolder(page, second);
    await waitForSubmission(script, 2);

    // Assert - 前のジョブを番号で名指しして止める。「どれかが止められた」
    // では足りない。画面を閉じるときには新しいジョブも止めるので、
    // 番号を見ない検証は後片付けの中断でも通ってしまう
    await expect
      .poll(() => posted, {
        message: `前の解析ジョブ (${firstJob}) を止めていない`,
        timeout: 15_000,
      })
      .toContain(`/api/jobs/${firstJob}/cancel`);

    // Assert - 止めたのは前のジョブで、新しいジョブは走ったまま
    expect(script.submitted[1]).not.toBe(firstJob);
    expect(posted, "投入し直した直後のジョブまで止めている").not.toContain(
      `/api/jobs/${script.submitted[1]}/cancel`,
    );
  });
});
