import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 整理済みと判定された本を、画面で読めるようにする（#73 第 3 段階）。
 *
 * 第 1・2 段階でサイドカーは「その本は既にこの道具が作る物そのものか」を
 * 判定し、`organized` / `organized_reason` として返すようになった。判定は
 * 画面に 1 文字も出ていない。利用者は一度整理した蔵書をもう一度投入したとき、
 * 何が作り直されるのかを実行するまで知る手立てがない。
 *
 * ここで足すのは**見せるだけ**。既定のチェック・作る冊数・状態の行の文言・
 * 出来上がる名前は 1 つも動かさない。整理済みの本を既定で外すこと（第 4 段階）
 * は、外した本を入れ直したときに本ごとの作品名・著者を持ち回る必要があり、
 * `OrganizeRequest` から `FileOrganizer` まで手が入る。判定を実際の蔵書へ
 * 当ててから決めたいので、見せることだけを先に切り離す。
 *
 * ここで求める画面の契約は次のとおり（すべて葉の行に付く）。
 *
 * - `data-organized`        … `"true"` / `"false"`。判定そのもの
 * - `data-organized-reason` … 整理済みでない理由 1 つ。整理済みなら空文字
 * - `plan-row-state`        … 整理済みの行に出す `Badge tone="ok"` + `CircleCheck`
 * - `plan-row-reason`       … 名前は合っているのに落ちた 3 つだけに出す
 *                             `Badge tone="neutral"` + `Info`（`data-reason` 付き）
 * - 行の `title`            … 整理済みでない本すべてに、理由を言葉で
 *
 * 理由 6 つのうち `multiple-books` / `not-zip` / `name-mismatch` に印は出さない。
 * この 3 つは「まだ整理していない蔵書」の普通の姿で、そこに印を足すと一覧が
 * 印だらけになり、印が何も指さなくなる。
 *
 * 判定そのものの契約は `services/core/tests/test_organized_detection.py`。
 * ここは判定を作り直さず、実際の整理に素材を作らせて画面まで運ぶ。
 */

const CORE_DIR = fileURLToPath(
  new URL("../../../services/core", import.meta.url),
);

/** 左の列に入れる作品名と著者。蔵書の中身と**わざと違える** */
const FORM_AUTHOR = "テスト著者";
const FORM_TITLE = "画面の作品";

/** 蔵書に入っている本の著者と作品名。整理済みの形はこの 2 つから決まる */
const SHELF_AUTHOR = "棚の著者";
const SHELF_TITLE = "棚の作品";

/** 放り込むフォルダの名前 */
const LIBRARY_NAME = "蔵書";

/** 整理済みでない理由。値そのものがサイドカーとの契約 */
const MULTIPLE_BOOKS = "multiple-books";
const NAME_MISMATCH = "name-mismatch";
const PAGES_MISMATCH = "pages-mismatch";
const EXTRA_ENTRIES = "extra-entries";
const FOLDER_MISMATCH = "folder-mismatch";

/**
 * 印を出す 3 つと、その文言。
 *
 * 名前は既に往復しているのに、置き場所・ページの並び・同梱物のどれかで
 * 落ちたもの。利用者から見ると「整っているのにまた作り直される」ので、
 * 何を直せば整理済みになるのかを言葉で出す。
 */
const REASON_BADGE: Record<string, string> = {
  [FOLDER_MISMATCH]: "フォルダ名が違います",
  [PAGES_MISMATCH]: "ページの連番が違います",
  [EXTRA_ENTRIES]: "余計なファイルがあります",
};

/** 蔵書に入れたアーカイブの数。1 冊出るもの 5 つ + 合本 1 つ */
const ARCHIVE_COUNT = 6;

/** 出来上がる本の数。合本からだけ 2 冊出る */
const BOOK_COUNT = 7;

/** 一覧の行数。放り込んだフォルダ 1 + アーカイブ + 本 */
const ROW_COUNT = 1 + ARCHIVE_COUNT + BOOK_COUNT;

/**
 * 素材を作るスクリプト。
 *
 * 整理済みの本は**整理そのもの**（`FileOrganizer`）に作らせる。手で組み立てると
 * 判定の定義を書き写すことになり、名前の作り方や連番の付け方が変わったときに
 * 「整理済みのはずの素材」が黙って未整理へ変わる。そうなるとこの spec の
 * 主張はすべて空振りするのに、落ちるのは 1 行だけになる。
 *
 * 派生させる 4 つは、整理済みの本を 1 つずつ崩して作る。崩す条件を 1 つに
 * 絞ることで、出てくる理由がその条件のものだと言い切れる。
 */
const FIXTURE_SCRIPT = `
import io
import json
import shutil
import sys
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from manga_core.file_organizer import FileOrganizer

library = Path(sys.argv[1])
author = sys.argv[2]
title = sys.argv[3]
series = f"[{author}] {title}"
PAGE_COUNT = 3
FONT = ImageFont.load_default(size=120)


def page(label: str) -> bytes:
    canvas = Image.new("RGB", (600, 900), "#3366cc")
    ImageDraw.Draw(canvas).text((300, 450), label, font=FONT, anchor="mm", fill="white")
    buffer = io.BytesIO()
    canvas.save(buffer, "JPEG", quality=85)
    return buffer.getvalue()


def sheets(prefix: str = "", names: list[str] | None = None) -> dict[str, bytes]:
    chosen = names or [f"{index:03d}.jpg" for index in range(1, PAGE_COUNT + 1)]
    return {f"{prefix}{name}": page(name) for name in chosen}


def zip_with(target: Path, entries: dict[str, bytes]) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return target


def copy_into(book: Path, folder: Path, name: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / name
    shutil.copy2(book, target)
    return target


# 整理に作らせる。素材は蔵書の外に置く（走査に拾わせない）
raw = zip_with(library.parent / "素材" / "素材_03.zip", sheets())
organizer = FileOrganizer(output_directory=library, keep_originals=True)
organizer.set_manga_info(author=author, title=title)
results = organizer.process_single_archive(raw)
failed = [result.error_message for result in results if not result.success]
if failed:
    raise SystemExit(f"整理が失敗した: {failed}")
built = results[0].output_path

# 素材が本当に「整理が作る物」であることをここで固定する。名前の作り方が
# 変われば組み立てが落ち、以降のテストが黙って別物を試すことがなくなる
expected = f"{series} 第003巻.zip"
if built.name != expected or built.parent.name != series:
    raise SystemExit(f"整理の出力が想定と違う: {built}")

# 同梱物だけが違う。名前・置き場所・ページの並びは整理済みのまま
extra = copy_into(built, library / series, f"{series} 第006巻.zip")
with zipfile.ZipFile(extra, "a", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("readme.txt", b"hello")

print(
    json.dumps(
        {
            # 名前だけが整理の作る形と違う。まだ整理していない本の普通の姿
            "nameMismatch": str(zip_with(library / series / "raw_09.zip", sheets())),
            # 003 が抜けて 004 が居る。枚数は合うので数えるだけでは気づけない
            "pagesMismatch": str(
                zip_with(
                    library / series / f"{series} 第005巻.zip",
                    sheets(names=["001.jpg", "002.jpg", "004.jpg"]),
                )
            ),
            "extraEntries": str(extra),
            # 中身も名前も整理済みのまま、置いてあるフォルダだけが違う
            "folderMismatch": str(
                copy_into(built, library / "その他", f"{series} 第007巻.zip")
            ),
            # 1 つの ZIP から 2 冊。この道具の成果物はファイルなので整理済みにならない
            "compound": str(
                zip_with(library / "合本.zip", {**sheets("第01巻/"), **sheets("第02巻/")})
            ),
            "organized": str(built),
        },
        ensure_ascii=False,
    )
)
`;

type Library = {
  /** 放り込むフォルダ */
  folder: string;
  /** 整理そのものが作った、整理済みの本 */
  organized: string;
  nameMismatch: string;
  pagesMismatch: string;
  extraEntries: string;
  folderMismatch: string;
  compound: string;
};

let sidecar: Sidecar;
let library: Library;

/** 一度整理した蔵書に、整理済みでない本が混ざった状態を作る */
function buildLibrary(): Library {
  const folder = join(sidecar.workDir, LIBRARY_NAME);
  mkdirSync(folder, { recursive: true });
  const scriptPath = join(sidecar.workDir, "make_organized_library.py");
  writeFileSync(scriptPath, FIXTURE_SCRIPT);
  const output = execFileSync(
    "uv",
    ["run", "python", scriptPath, folder, SHELF_AUTHOR, SHELF_TITLE],
    { cwd: CORE_DIR, encoding: "utf8" },
  );
  return { folder, ...JSON.parse(output.trim().split("\n").pop()!) };
}

test.beforeAll(async () => {
  sidecar = await startSidecar();
  library = buildLibrary();
});

test.afterAll(() => sidecar?.stop());

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

/** ファイル参照から、蔵書を丸ごと 1 回で投入する */
async function addLibraryFolder(page: Page) {
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  await page
    .locator(`[data-testid="browse-entry"][data-name="${LIBRARY_NAME}"]`)
    .getByRole("button", { name: "フォルダごと追加" })
    .click();
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeHidden();
}

/**
 * 投入 → 解析まで済ませた状態を作る。
 *
 * 左の列には蔵書の中身と違う作品名・著者を入れる。判定が依頼の値を見て
 * いるなら、整理済みの本はここで整理済みでなくなる。
 */
async function preparePlan(page: Page, name: string) {
  const output = join(sidecar.workDir, `out-${name}`);
  mkdirSync(output, { recursive: true });
  await openOrganize(page, output);
  await stubNoSuggestions(page);
  await page.getByTestId("organize-title").fill(FORM_TITLE);
  await page.getByTestId("organize-author").fill(FORM_AUTHOR);
  await expect(page.getByTestId("organize-author")).toHaveValue(FORM_AUTHOR);
  await addLibraryFolder(page);
  await expect(
    page.locator('[data-testid="plan-row"][data-kind="book"]'),
    "解析した本が一覧に出ていない",
  ).toHaveCount(BOOK_COUNT, { timeout: 60_000 });
}

/**
 * 本の行。元になったアーカイブで引く。
 *
 * 出来上がる名前で引かないのは、名前が左の列の作品名・著者から組み立て直され、
 * 第 4 段階（本ごとの名前）で変わりうるため。素材との対応は元パスで固定する。
 */
function bookRow(page: Page, source: string, entry = ""): Locator {
  return page.locator(
    `[data-testid="plan-row"][data-kind="book"]` +
      `[data-source="${source}"][data-entry="${entry}"]`,
  );
}

/** 一覧に出ている本の行を、上から順に読み取った形 */
type BookRow = {
  source: string;
  entry: string;
  outputName: string;
  organized: string | null;
  reason: string | null;
  /** 行に乗せたときに出る説明 */
  tip: string | null;
};

async function readBookRows(page: Page): Promise<BookRow[]> {
  const rows = await page
    .locator('[data-testid="plan-row"][data-kind="book"]')
    .all();
  return Promise.all(
    rows.map(async (row) => ({
      source: (await row.getAttribute("data-source")) ?? "",
      entry: (await row.getAttribute("data-entry")) ?? "",
      outputName: (await row.getAttribute("data-output-name")) ?? "",
      organized: await row.getAttribute("data-organized"),
      reason: await row.getAttribute("data-organized-reason"),
      tip: await row.getAttribute("title"),
    })),
  );
}

test.describe("整理済みの本の見せ方", () => {
  test("整理済みの本にだけ、整理済みと読める印が付く", async ({ page }) => {
    // Arrange / Act
    await preparePlan(page, "整理済みの印");

    // Assert - 判定が行の属性として読める
    const organized = bookRow(page, library.organized);
    await expect(organized, "整理済みの本の行が無い").toHaveCount(1);
    await expect(
      organized,
      "整理済みと判定された本の行に判定が出ていない",
    ).toHaveAttribute("data-organized", "true");
    // 整理済みに理由は無い。欄そのものは省かない（data-issues と同じ扱い）
    await expect(organized).toHaveAttribute("data-organized-reason", "");

    // Assert - 緑の状態バッジ。警告（warn + TriangleAlert）と同じ席に置くが、
    // 色と絵で「壊れている」ではなく「終わっている」と読める
    const state = organized.getByTestId("plan-row-state");
    await expect(state, "整理済みバッジが無い").toHaveText("整理済み");
    await expect(state, "整理済みバッジが ok の色になっていない").toHaveClass(
      /\btext-ok\b/,
    );
    await expect(
      state.locator("svg.lucide-circle-check"),
      "整理済みバッジの絵が CircleCheck でない",
    ).toHaveCount(1);

    // Assert - 行に乗せると、何をもって整理済みなのかが読める
    const tip = await state.getAttribute("title");
    expect(tip ?? "", "整理済みバッジに説明が無い").not.toBe("");

    // Assert - 印は行の右側、警告バッジと同じ席に出る。左端に割り込むと
    // 名前と場所の並びが行ごとにずれる
    const rowBox = (await organized.boundingBox())!;
    const badgeBox = (await state.boundingBox())!;
    expect(badgeBox.x, "整理済みバッジが行の右側の席に無い").toBeGreaterThan(
      rowBox.x + rowBox.width / 2,
    );

    // Assert - 対照。同じ蔵書に整理済みでない本が居て、そちらには印が無い。
    // 全部が整理済みの蔵書で試すと「印がある」は何も確かめていない
    const messy = bookRow(page, library.nameMismatch);
    await expect(messy, "整理済みでない本の行が無い").toHaveCount(1);
    await expect(
      messy,
      "整理済みでない本まで整理済みと判定されている",
    ).toHaveAttribute("data-organized", "false");
    await expect(
      messy.getByTestId("plan-row-state"),
      "整理済みでない本に整理済みバッジが付いている",
    ).toHaveCount(0);

    // Assert - 印が付いた本の行はこの 1 冊だけ。全部の行に付ける実装では
    // 印そのものが意味を失う
    await expect(
      page.locator(
        '[data-testid="plan-row"][data-kind="book"] [data-testid="plan-row-state"]',
      ),
      "整理済みバッジが 1 冊より多くの行に付いている",
    ).toHaveCount(1);
  });

  test("名前は合っているのに落ちた 3 つだけに、理由の印が出る", async ({
    page,
  }) => {
    // Arrange / Act
    await preparePlan(page, "理由の印");

    // Assert - 置き場所・ページの並び・同梱物で落ちた 3 冊。名前は既に
    // 往復しているので、利用者には「整っているのに作り直される」と見える。
    // 何を直せば整理済みになるのかを言葉で出す
    for (const [source, reason] of [
      [library.folderMismatch, FOLDER_MISMATCH],
      [library.pagesMismatch, PAGES_MISMATCH],
      [library.extraEntries, EXTRA_ENTRIES],
    ] as const) {
      const row = bookRow(page, source);
      await expect(row, `${reason} の本の行が無い`).toHaveCount(1);
      await expect(row, `${reason} が行の属性に出ていない`).toHaveAttribute(
        "data-organized-reason",
        reason,
      );

      const badge = row.locator(
        `[data-testid="plan-row-reason"][data-reason="${reason}"]`,
      );
      await expect(badge, `${reason} の印が無い`).toHaveText(
        REASON_BADGE[reason],
      );
      // 警告（warn + TriangleAlert）ではない。直さなくても壊れてはいない
      await expect(
        badge,
        `${reason} の印が neutral の色になっていない`,
      ).toHaveClass(/\btext-ink-muted\b/);
      await expect(
        badge.locator("svg.lucide-info"),
        `${reason} の印の絵が Info でない`,
      ).toHaveCount(1);
    }

    // Assert - 対照 1。まだ整理していない蔵書の普通の姿（名前が違う）には
    // 印を出さない。整理済みでない行すべてに出す実装では、一覧が印で埋まり、
    // 直せば整理済みになる 3 つが見分けられなくなる
    const messy = bookRow(page, library.nameMismatch);
    await expect(messy).toHaveAttribute("data-organized-reason", NAME_MISMATCH);
    await expect(
      messy.getByTestId("plan-row-reason"),
      "名前が違うだけの本にまで理由の印が出ている",
    ).toHaveCount(0);

    // Assert - 対照 2。合本から出た 2 冊も印を出さない。中身の 1 冊は
    // どうやっても整理済みにならないので、直せる指示にならない
    for (const entry of ["第01巻", "第02巻"]) {
      const inside = bookRow(page, library.compound, entry);
      await expect(inside, `合本の ${entry} の行が無い`).toHaveCount(1);
      await expect(inside).toHaveAttribute(
        "data-organized-reason",
        MULTIPLE_BOOKS,
      );
      await expect(
        inside.getByTestId("plan-row-reason"),
        `合本の ${entry} にまで理由の印が出ている`,
      ).toHaveCount(0);
    }

    // Assert - 印が出た行はちょうど 3 つ
    await expect(
      page.locator(
        '[data-testid="plan-row"][data-kind="book"] [data-testid="plan-row-reason"]',
      ),
      "理由の印が 3 冊より多くの行に出ている",
    ).toHaveCount(3);
  });

  test("整理済みでない本は、行に乗せると理由が読める", async ({ page }) => {
    // Arrange / Act
    await preparePlan(page, "行の説明");

    // Assert - 印を出さない 3 つ（multiple-books / not-zip / name-mismatch）も
    // 含めて、整理済みでない本にはすべて説明が付く。印は出さないが、
    // 「なぜまた作られるのか」を知る手立ては残す
    const rows = await readBookRows(page);
    expect(rows, "本の行が読めない").toHaveLength(BOOK_COUNT);
    const unorganized = rows.filter((row) => row.organized === "false");
    expect(
      unorganized.length,
      `整理済みでない本が数えられない: ${JSON.stringify(rows)}`,
    ).toBe(BOOK_COUNT - 1);

    const tips = new Map<string, Set<string>>();
    for (const row of unorganized) {
      const reason = row.reason ?? "";
      const tip = row.tip ?? "";
      expect(reason, `理由の欄が空: ${row.source}`).not.toBe("");
      expect(tip, `説明が無い: ${row.source}`).not.toBe("");

      // 説明は利用者に向けた言葉であること。理由の記号や、行に既に出ている
      // 名前・場所をそのまま `title` に入れても「空でない」は満たせてしまう
      expect(tip, `説明が理由の記号のまま: ${row.source}`).not.toBe(reason);
      expect(tip, `説明が出来上がる名前のまま: ${row.source}`).not.toBe(
        row.outputName,
      );
      expect(tip, `説明が元のパスのまま: ${row.source}`).not.toBe(row.source);
      expect(tip, `説明が日本語になっていない: ${tip}`).toMatch(
        /[ぁ-んァ-ヶ一-龠]/,
      );

      const found = tips.get(reason) ?? new Set<string>();
      found.add(tip);
      tips.set(reason, found);
    }

    // Assert - 理由が違えば説明も違う。全部に同じ 1 文を出す実装では、
    // 「説明がある」ことは確かめられても、理由を言っていることは確かめられない
    for (const [reason, found] of tips) {
      expect(
        [...found],
        `同じ理由なのに説明が揺れている: ${reason}`,
      ).toHaveLength(1);
    }
    const distinct = new Set([...tips.values()].map((found) => [...found][0]));
    expect(
      distinct.size,
      `理由が違うのに同じ説明が出ている: ${JSON.stringify([...tips])}`,
    ).toBe(tips.size);

    // Assert - 蔵書には理由が 5 種類そろっている。1 種類しか無い蔵書で
    // 「違う説明が出る」と言っても何も確かめたことにならない
    expect(
      [...tips.keys()].sort(),
      `理由がそろっていない: ${[...tips.keys()]}`,
    ).toEqual(
      [
        MULTIPLE_BOOKS,
        NAME_MISMATCH,
        PAGES_MISMATCH,
        EXTRA_ENTRIES,
        FOLDER_MISMATCH,
      ].sort(),
    );
  });

  test("見せるだけで、既定のチェックも件数も行数も動かない", async ({
    page,
  }) => {
    // Arrange / Act
    await preparePlan(page, "動かない");

    // Assert - 行の数は増えも減りもしない。整理済みの入れ物を 1 行に
    // まとめる案は判定を実際の蔵書へ当ててから決める
    const rows = page.getByTestId("plan-row");
    await expect(rows, "一覧の行数が変わっている").toHaveCount(ROW_COUNT);
    for (const [kind, count] of [
      ["folder", 1],
      ["archive", ARCHIVE_COUNT],
      ["book", BOOK_COUNT],
    ] as const) {
      await expect(
        page.locator(`[data-testid="plan-row"][data-kind="${kind}"]`),
        `${kind} の行数が変わっている`,
      ).toHaveCount(count);
    }

    // Assert - 既定は今までどおり全部オン。整理済みの本も、外れているのは
    // 見た目だけ…ではなく、そもそも外れない。既定を変えるのは第 4 段階
    const checks = page.getByTestId("plan-check");
    await expect(checks, "チェックが無い行がある").toHaveCount(ROW_COUNT);
    const states = await Promise.all(
      (await checks.all()).map((check) => check.getAttribute("aria-checked")),
    );
    expect(
      states.filter((state) => state !== "true").length,
      `既定でオンになっていない行がある: ${JSON.stringify(states)}`,
    ).toBe(0);
    await expect(page.getByTestId("plan-master-check")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // Assert - 状態の行の文言も、作る冊数も動かない。「K 冊は整理済みなので
    // 作りません」を足すのは、実際に作らなくなる第 4 段階と同時でなければ嘘になる
    await expect(
      page.getByTestId("organize-status"),
      "状態の行の文言が変わっている",
    ).toHaveText(`${BOOK_COUNT} 冊を作ります`);

    // Assert - 判定が画面まで届いていること。整理済みが 1 冊も無い蔵書なら
    // 「何も動いていない」は当たり前で、第 3 段階を試したことにならない。
    // 上の 3 つを先に見てから確かめるのは、この 1 行が落ちる前に
    // 「今までどおり」が本当に成り立っているかを毎回通すため
    await expect(
      page.locator('[data-testid="plan-row"][data-organized="true"]'),
      "整理済みと判定された行が 1 つも無い",
    ).toHaveCount(1);
  });
});
