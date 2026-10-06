import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 整理済みの蔵書を、そのまま辞書へ取り込む（#73 段階 6）。
 *
 * 整理し終えた蔵書は、それ自体が「作品名 → 著者」の対応表になっている。
 * 段階 4a で、整理済みの本は自分の作品名と著者を名前から読み取って行に
 * 持つようになった。その対をまとめて辞書へ入れられれば、以降の整理では
 * 著者欄が勝手に埋まる。
 *
 * 判定はこの逆流を受け取らない。辞書を見て整理済みと判定することはしない
 * （PC ごとに違う可変の状態で判定が変わるうえ、往復しない名前でも辞書に
 * 当たれば整理済みと見なす抜け道になる）。流れるのは判定 → 辞書の一方向だけ。
 *
 * ## 画面の契約（実装者が満たすもの）
 *
 * - 操作は辞書ダイアログの中。`data-testid="library-import"`
 *   - `data-count` に件数、文字にも「N 件」。入れるものが無ければ**出さない**
 *   - 件数は画面が数える。整理済みの行の（作品名・著者）の対のうち、
 *     いま辞書がその対で覚えていないものの数
 *   - 数える元は**整理済みの行**であって、チェックの入っている行ではない。
 *     整理済みの行は既定でオフ（段階 4b）なので、選択から数えると常に 0 になる
 * - 結果は `data-testid="library-import-result"`
 * - 断られた対は `data-testid="library-import-conflict"`（`data-title` 付き）に
 *   1 件ずつ。辞書に残った著者と蔵書の著者の**両方**を文字で出す
 * - 一覧の行 `data-testid="library-entry"` に `data-author` を足す。
 *   どの作品名にどの著者が入ったかを、行ごとに読めるようにするため
 * - 一度応答をもらった対は、もう出さない。断られた対を出し続けると、
 *   押しても何も起きない操作が画面に残り続ける
 *
 * サイドカー側の契約は `services/core/tests/test_library_import.py`。
 * ここは判定も取り込みの規則も作り直さず、実際の整理に素材を作らせて
 * 画面から通す。
 */

const CORE_DIR = fileURLToPath(
  new URL("../../../services/core", import.meta.url),
);

/** 放り込むフォルダの名前 */
const LIBRARY_NAME = "蔵書";

/**
 * 蔵書に入っている作品。整理そのものに作らせる。
 *
 * 3 作あるのは、辞書との突き合わせに 3 通りが要るため。1 作目は辞書に無い、
 * 2 作目は同じ著者で既にある、3 作目は違う著者で既にある。1 作しか無いと
 * 「無いものだけ足す」も「上書きしない」も確かめられない。
 *
 * 1 作目だけ 2 巻あるのは、同じ対が巻数のぶんだけ来ることを画面の件数でも
 * 見るため。冊数で数える実装はここで 4 件と出る。
 */
const SERIES = [
  { author: "棚の著者", title: "棚の作品", volumes: [1, 2] },
  { author: "別の著者", title: "別の作品", volumes: [1] },
  { author: "第三の著者", title: "第三の作品", volumes: [1] },
] as const;

/** 3 作目について、利用者が手で直したことにする著者 */
const CURATED_AUTHOR = "違う人";

/** 蔵書の中の、まだ整理していないアーカイブ */
const LOOSE_NAME = "raw_09.zip";

/** 左の列に入れる作品名と著者。蔵書の中身と**わざと違える** */
const FORM_TITLE = "画面の作品";
const FORM_AUTHOR = "テスト著者";

/** 整理済みと判定される本の数。1 作目 2 巻 + 2 作目 + 3 作目 */
const ORGANIZED_COUNT = 4;

/** 一覧に出る本の数。整理済み 4 + まだ整理していない 1 */
const BOOK_COUNT = ORGANIZED_COUNT + 1;

/** 整理済みの本が持つ、作品名と著者の対の数 */
const PAIR_COUNT = SERIES.length;

/**
 * 素材を作るスクリプト。
 *
 * 整理済みの本は**整理そのもの**（`FileOrganizer`）に作らせる。手で組み立てると
 * 判定の定義を書き写すことになり、名前の作り方が変わったときに「整理済みの
 * はずの素材」が黙って未整理へ変わる。そうなるとこの spec の主張はすべて
 * 空振りするのに、落ちるのは 1 行だけになる。
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

root = Path(sys.argv[1])
library = root / sys.argv[2]
loose_name = sys.argv[3]
series = json.loads(sys.argv[4])
built_root = root / "組み上げ"
PAGE_COUNT = 3
FONT = ImageFont.load_default(size=120)


def page(label: str) -> bytes:
    canvas = Image.new("RGB", (600, 900), "#3366cc")
    ImageDraw.Draw(canvas).text((300, 450), label, font=FONT, anchor="mm", fill="white")
    buffer = io.BytesIO()
    canvas.save(buffer, "JPEG", quality=85)
    return buffer.getvalue()


def sheets() -> dict[str, bytes]:
    return {f"{index:03d}.jpg": page(str(index)) for index in range(1, PAGE_COUNT + 1)}


def zip_with(target: Path, entries: dict[str, bytes]) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return target


for index, item in enumerate(series):
    author, title, volumes = item["author"], item["title"], item["volumes"]
    organizer = FileOrganizer(output_directory=built_root, keep_originals=True)
    organizer.set_manga_info(author=author, title=title)
    folder = f"[{author}] {title}"
    for volume in volumes:
        raw = zip_with(root / "素材" / str(index) / f"素材_{volume:02d}.zip", sheets())
        results = organizer.process_single_archive(raw)
        failed = [result.error_message for result in results if not result.success]
        if failed:
            raise SystemExit(f"整理が失敗した: {failed}")
        built = results[0].output_path
        # 素材が本当に「整理が作る物」であることをここで固定する。名前の作り方が
        # 変われば組み立てが落ち、以降のテストが黙って別物を試すことがなくなる
        expected = f"{folder} 第{volume:03d}巻.zip"
        if built.name != expected or built.parent.name != folder:
            raise SystemExit(f"整理の出力が想定と違う: {built}")

# 整理済みの本を丸ごと蔵書へ複製する。複製でも判定は整理済みのまま
shutil.copytree(built_root, library, dirs_exist_ok=True)
made = sorted(str(path) for path in library.rglob("*.zip"))
if len(made) != sum(len(item["volumes"]) for item in series):
    raise SystemExit(f"蔵書への複製が出来ていない: {made}")

# まだ整理していないアーカイブを 1 つ混ぜる。名前だけが整理の作る形と違う
first = series[0]
loose = zip_with(library / f"[{first['author']}] {first['title']}" / loose_name, sheets())

print(json.dumps({"library": str(library), "loose": str(loose)}, ensure_ascii=False))
`;

let sidecar: Sidecar;

/** 一度だけ組み上げた素材の置き場。テストごとにここから複製する */
let fixtureLibrary: string;

/**
 * 素材を組み上げる。
 *
 * 組み上げはテストの外で一度だけ行い、テストごとにはその複製を新しい
 * サイドカーの下へ置く。サイドカーは辞書をその作業場所に持つので、
 * テストごとに立て直せば辞書は必ず空から始まる。前のテストが入れた対が
 * 残っていると、「入れるものが無いときは出さない」は前のテストの結果を
 * 見ているだけになる。
 */
function buildFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "manga-e2e-dict-"));
  const scriptPath = join(root, "make_library.py");
  writeFileSync(scriptPath, FIXTURE_SCRIPT);
  const output = execFileSync(
    "uv",
    [
      "run",
      "python",
      scriptPath,
      root,
      LIBRARY_NAME,
      LOOSE_NAME,
      JSON.stringify(SERIES),
    ],
    { cwd: CORE_DIR, encoding: "utf8" },
  );
  return JSON.parse(output.trim().split(/\r?\n/).pop()!).library as string;
}

test.beforeAll(() => {
  fixtureLibrary = buildFixture();
});

test.beforeEach(async () => {
  sidecar = await startSidecar();
  cpSync(fixtureLibrary, join(sidecar.workDir, LIBRARY_NAME), {
    recursive: true,
  });
});

test.afterEach(() => sidecar?.stop());

/** ファイル整理の画面を開く。出力先は使わないが、実機と同じ形で渡す */
async function openOrganize(page: Page, name: string) {
  const output = join(sidecar.workDir, `out-${name}`);
  mkdirSync(output, { recursive: true });
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // 外部検索は「候補なし」に固定する。著者の補完はここでは見ない
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

/** 本の行が出そろうまで待つ。解析は往復を挟むので、待たずに読むと空になる */
async function waitForBooks(page: Page) {
  await expect(
    page.locator('[data-testid="plan-row"][data-kind="book"]'),
    "解析した本が一覧に出ていない",
  ).toHaveCount(BOOK_COUNT, { timeout: 60_000 });
}

/**
 * 素材が思ったとおりに読めていることを、先に押さえる。
 *
 * 整理済みが 4 冊・未整理が 1 冊という前提が崩れていると、この後の件数は
 * 何を数えているのか分からなくなる。あわせて整理済みの行が既定でオフで
 * あることも見る。取り込みの件数を「チェックの入っている本」から数える
 * 実装は、この状態で 0 件になる。
 */
async function assertShelfIsAsExpected(page: Page) {
  await expect(
    page.locator(
      '[data-testid="plan-row"][data-kind="book"][data-organized="true"]',
    ),
    "整理済みと判定された本の数が違う",
  ).toHaveCount(ORGANIZED_COUNT);
  await expect(
    page.locator(
      '[data-testid="plan-row"][data-kind="book"][data-organized="false"]',
    ),
    "まだ整理していない本が蔵書に居ない。取り込みの選り分けが確かめられない",
  ).toHaveCount(1);
  const checks = page.locator(
    '[data-testid="plan-row"][data-organized="true"] [data-testid="plan-check"]',
  );
  for (const check of await checks.all()) {
    await expect(
      check,
      "整理済みの行が既定でオフになっていない（前提が崩れている）",
    ).toHaveAttribute("aria-checked", "false");
  }
}

/** 辞書ダイアログを開く */
async function openLibrary(page: Page) {
  await page.getByTestId("open-library").click();
  await expect(page.getByTestId("library-dialog")).toBeVisible();
}

/** 辞書ダイアログを閉じる */
async function closeLibrary(page: Page) {
  await page.getByTestId("library-close").click();
  await expect(page.getByTestId("library-dialog")).toBeHidden();
}

/**
 * 辞書へ 1 件、手で記録する。既にある辞書の中身を作るのに使う。
 *
 * 仕込みの確認だけは行の文字で見る。判定に使う `data-author` は段階 6 で
 * 足す属性なので、ここで待つと下ごしらえで落ち、テストが本題まで届かない。
 */
async function rememberEntry(page: Page, title: string, author: string) {
  await page.getByTestId("new-title").fill(title);
  await page.getByTestId("new-author").fill(author);
  await page.getByTestId("library-save").click();
  await expect(
    entryRow(page, title),
    `${title} を仕込めていない`,
  ).toContainText(author);
}

/** 辞書の 1 行。作品名で引き、著者は属性で読む */
function entryRow(page: Page, title: string): Locator {
  return page.locator(`[data-testid="library-entry"][data-title="${title}"]`);
}

/** 取り込みの操作 */
function importButton(page: Page): Locator {
  return page.getByTestId("library-import");
}

test.describe("整理済みの蔵書を辞書に入れる", () => {
  test("整理済みの作品だけが入り、辞書にある著者は上書きされない", async ({
    page,
  }) => {
    test.slow();
    // Arrange - 辞書に 2 件仕込む。空の辞書から始めると「上書きしない」は
    // 言うまでもなく成り立ち、何も確かめていないことになる
    await openOrganize(page, "取り込み");
    await openLibrary(page);
    // 蔵書と同じ著者。これは食い違いではなく「既に在るだけ」
    await rememberEntry(page, SERIES[1].title, SERIES[1].author);
    // 利用者が手で直した著者だとする。蔵書の著者とは違う
    await rememberEntry(page, SERIES[2].title, CURATED_AUTHOR);
    await closeLibrary(page);

    // Arrange - 左の列には蔵書と違う作品名・著者を入れておく。ここを
    // 取り込む実装（解析したもの全部を入れる実装）を落とすための罠
    await page.getByTestId("organize-title").fill(FORM_TITLE);
    await page.getByTestId("organize-author").fill(FORM_AUTHOR);
    await addLibraryFolder(page);
    await waitForBooks(page);
    await assertShelfIsAsExpected(page);

    // Act - 辞書を開くと、入れられる対の数が出ている
    await openLibrary(page);
    const action = importButton(page);
    await expect(action, "辞書に入れる操作が出ていない").toHaveCount(1);
    // 3 作のうち、辞書がその対で覚えていない 2 作。同じ著者で既にある
    // 1 作は数えない。冊数（4 冊）で数える実装もここで落ちる
    await expect(action, "入れられる対の数が違う").toHaveAttribute(
      "data-count",
      "2",
    );
    await expect(action, "件数が読めない").toContainText("2 件");

    // Act
    await action.click();

    // Assert - 辞書に無かった対が入った。これが無いと、以下の「変わって
    // いない」はすべて「取り込みが走らなかった」でも成り立つ
    await expect(
      entryRow(page, SERIES[0].title),
      "辞書に無かった作品が入っていない",
    ).toHaveAttribute("data-author", SERIES[0].author);

    // Assert - 手で直した著者は残っている
    await expect(
      entryRow(page, SERIES[2].title),
      "辞書にある著者が蔵書の著者で上書きされた。" +
        "以降の整理はこの表から著者欄を埋めるので、直した覚えが消える",
    ).toHaveAttribute("data-author", CURATED_AUTHOR);

    // Assert - 同じ著者で既にあったものも、そのまま
    await expect(
      entryRow(page, SERIES[1].title),
      "既に同じ著者で在った作品の著者が変わった",
    ).toHaveAttribute("data-author", SERIES[1].author);

    // Assert - 断られたことが、両方の著者ごと利用者に伝わる。黙って捨てると
    // 「押したのに変わらない」だけになり、どちらが正しいのか確かめられない
    const conflict = page.locator(
      `[data-testid="library-import-conflict"][data-title="${SERIES[2].title}"]`,
    );
    await expect(conflict, "断られた対が画面に出ていない").toHaveCount(1);
    await expect(conflict, "辞書に残した著者が読めない").toContainText(
      CURATED_AUTHOR,
    );
    await expect(conflict, "蔵書の側の著者が読めない").toContainText(
      SERIES[2].author,
    );
    // 同じ著者で既にあったものは食い違いではない。ここに混ぜると、一度
    // 整理した蔵書を入れ直すたびに、直すところが無いのに警告が出る
    await expect(
      page.getByTestId("library-import-conflict"),
      "同じ著者で既にあるものまで食い違いとして出している",
    ).toHaveCount(1);
    await expect(
      page.getByTestId("library-import-result"),
      "何が起きたのかが出ていない",
    ).toBeVisible();

    // Assert - 入ったのは整理済みの対だけ。左の列の作品名も、まだ整理して
    // いない本も入らない
    await expect(
      entryRow(page, FORM_TITLE),
      "左の列に打った作品名まで辞書に入れている",
    ).toHaveCount(0);
    await expect(
      page.getByTestId("entry-count"),
      "辞書の件数が違う。整理済みの対以外まで入っている",
    ).toHaveText(`${PAIR_COUNT} 件`);

    // Assert - 断られた対をもう一度出さない。出し続けると、押しても何も
    // 起きない操作が画面に残り続ける
    await expect(
      importButton(page),
      "入れるものが無いのに、辞書に入れる操作が残っている",
    ).toHaveCount(0);
  });

  test("入れるものが無ければ、辞書に入れる操作は出ない", async ({ page }) => {
    test.slow();
    // Arrange - まだ何も投入していない。整理済みの本は 1 冊も無い
    await openOrganize(page, "出ない");
    await openLibrary(page);
    await expect(
      importButton(page),
      "整理済みの本が 1 冊も無いのに、辞書に入れる操作が出ている",
    ).toHaveCount(0);
    await closeLibrary(page);

    // Act - 蔵書を投入して解析する
    await addLibraryFolder(page);
    await waitForBooks(page);
    await assertShelfIsAsExpected(page);
    await openLibrary(page);

    // Assert - 対照。出ないことが「そもそも出せない」ではないと示す
    await expect(
      importButton(page),
      "整理済みの本があるのに、辞書に入れる操作が出ない",
    ).toHaveAttribute("data-count", String(PAIR_COUNT));

    // Act
    await importButton(page).click();

    // Assert - 3 作が、それぞれの著者で入った
    for (const item of SERIES) {
      await expect(
        entryRow(page, item.title),
        `${item.title} が入っていない`,
      ).toHaveAttribute("data-author", item.author);
    }
    await expect(
      page.getByTestId("entry-count"),
      "辞書の件数が違う。巻数のぶんだけ同じ対を入れている",
    ).toHaveText(`${PAIR_COUNT} 件`);
    await expect(
      importButton(page),
      "入れ終わったのに、辞書に入れる操作が残っている",
    ).toHaveCount(0);

    // Act - 画面を開き直して、同じ蔵書をもう一度投入する。押した覚えを
    // 画面が持っているだけなら、ここで操作が戻ってくる
    await openOrganize(page, "出ない2");
    await addLibraryFolder(page);
    await waitForBooks(page);
    await openLibrary(page);

    // Assert - 辞書が既に同じ対を覚えているので、入れるものは無い
    await expect(
      importButton(page),
      "辞書に既にある対を、もう一度入れようとしている",
    ).toHaveCount(0);
    await expect(
      page.getByTestId("entry-count"),
      "辞書の件数が変わっている",
    ).toHaveText(`${PAIR_COUNT} 件`);
  });
});
