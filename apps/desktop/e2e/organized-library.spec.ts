import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 整理済みと判定された本を、画面で読めるようにし（#73 第 3 段階）、
 * 既定で作らないようにする（#73 段階 4b）。
 *
 * 第 1・2 段階でサイドカーは「その本は既にこの道具が作る物そのものか」を
 * 判定し、`organized` / `organized_reason` として返すようになった。第 3 段階で
 * その判定を画面に出した。段階 4a で、整理済みの本が自分の名前のまま画面から
 * 投入まで通るようになった。
 *
 * ここまでで足りないのは**既定**だけになる。一度整理した蔵書をもう一度
 * 投入すると、整理済みの本まで既定でオンのまま作り直される。段階 4b で
 * その既定を裏返す。
 *
 * **第 3 段階の「見せるだけ」はここで終わる。** 冒頭のこの節はそのときの
 * 約束（既定のチェック・作る冊数・状態の行の文言を 1 つも動かさない）を
 * 書いていた。4 つ目のテストがその約束そのものだったので、ここでは新しい
 * 真実へ書き換える。行数の主張だけは変えない。整理済みの行は消さずに残す。
 *
 * ここで求める画面の契約は次のとおり（第 3 段階のぶんも残す）。
 *
 * - `data-organized`        … `"true"` / `"false"`。判定そのもの
 * - `data-organized-reason` … 整理済みでない理由 1 つ。整理済みなら空文字
 * - `plan-row-state`        … 整理済みの行に出す `Badge tone="ok"` + `CircleCheck`
 * - `plan-row-reason`       … 名前は合っているのに落ちた 3 つだけに出す
 *                             `Badge tone="neutral"` + `Info`（`data-reason` 付き）
 * - 行の `title`            … 整理済みでない本すべてに、理由を言葉で
 *
 * 段階 4b で足すのは次の 4 つ。
 *
 * - 整理済みの**本**の行は既定でオフ。それ以外の行は既定でオン。行は残る
 * - 状態の行は「外した」と「整理済みなので作りません」を別の言葉で数える
 * - 入れ直した整理済みの本は、解析をやり直しても入ったまま。触っていない
 *   整理済みの本は外れたまま（覚えるのは利用者が触った行だけ）
 * - 残した本が全部自分の名前を持つなら、左の列は空でも実行できる
 *
 * 理由 6 つのうち `multiple-books` / `not-zip` / `name-mismatch` に印は出さない。
 * この 3 つは「まだ整理していない蔵書」の普通の姿で、そこに印を足すと一覧が
 * 印だらけになり、印が何も指さなくなる。
 *
 * 段階 4c は行そのものの仕上げで、足りない契約は下の「整理済みの行の仕上げ」の
 * 節にまとめる。素材は 4b と同じものを使う。
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

/** 蔵書に入っている 1 作目の著者と作品名。整理済みの形はこの 2 つから決まる */
const SHELF_AUTHOR = "棚の著者";
const SHELF_TITLE = "棚の作品";

/**
 * 2 作目の著者と作品名。
 *
 * 段階 4b では「作品フォルダが 2 つ出来る」ことを見る。1 作しか無い蔵書だと、
 * 本ごとの名前を使わずに 1 つの対で全部作る実装でも同じ結果になってしまう。
 */
const OTHER_AUTHOR = "別の著者";
const OTHER_TITLE = "別の作品";

/** 整理済みの本の巻数。作品ごとに 2 冊ずつ */
const ORGANIZED_VOLUMES = [3, 4];

/** 放り込むフォルダの名前 */
const LIBRARY_NAME = "蔵書";

/** 整理済みの本だけが入ったフォルダの名前 */
const ORGANIZED_NAME = "整理済み";

/** 蔵書の外に置く、まだ整理していないアーカイブ 1 つ */
const LOOSE_NAME = "未整理_09.zip";

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

/** 蔵書に入っている整理済みの本の数。2 作 × 2 巻 */
const ORGANIZED_COUNT = 4;

/**
 * 蔵書に入れたアーカイブの数。
 *
 * 整理済み 4 つ + 整理済みでない 1 冊もの 4 つ + 合本 1 つ。
 */
const ARCHIVE_COUNT = 9;

/** 出来上がる本の数。合本からだけ 2 冊出る */
const BOOK_COUNT = 10;

/** 一覧の行数。放り込んだフォルダ 1 + アーカイブ + 本 */
const ROW_COUNT = 1 + ARCHIVE_COUNT + BOOK_COUNT;

/** 既定で作る冊数。整理済みは外れるので、その分だけ減る */
const DEFAULT_KEPT = BOOK_COUNT - ORGANIZED_COUNT;

/**
 * 素材を作るスクリプト。
 *
 * 整理済みの本は**整理そのもの**（`FileOrganizer`）に作らせる。手で組み立てると
 * 判定の定義を書き写すことになり、名前の作り方や連番の付け方が変わったときに
 * 「整理済みのはずの素材」が黙って未整理へ変わる。そうなるとこの spec の
 * 主張はすべて空振りするのに、落ちるのは 1 行だけになる。
 *
 * 整理済みの本は先に `整理済み/` へ作り、その丸ごとの複製を `蔵書/` に置く。
 * 複製でも名前・置き場所・ページの並び・同梱物はそのままなので、判定は
 * 整理済みのまま変わらない。2 つに分けるのは、「整理済みの本しか入っていない
 * 蔵書」を作るため。段階 4b の要は「全部整理済みで、何も作らない」場面の
 * 振る舞いなので、そこに未整理の本が混ざっていると確かめられない。
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

root = Path(sys.argv[1])
library = root / sys.argv[2]
organized_root = root / sys.argv[3]
shelf_author, shelf_title = sys.argv[4], sys.argv[5]
other_author, other_title = sys.argv[6], sys.argv[7]
loose_name = sys.argv[8]
volumes = [int(value) for value in sys.argv[9:]]
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


def build(slug: str, author: str, title: str) -> list[Path]:
    """整理に作らせる。素材は蔵書の外に置く（走査に拾わせない）"""
    organizer = FileOrganizer(output_directory=organized_root, keep_originals=True)
    organizer.set_manga_info(author=author, title=title)
    series = f"[{author}] {title}"
    made = []
    for volume in volumes:
        raw = zip_with(root / "素材" / slug / f"素材_{volume:02d}.zip", sheets())
        results = organizer.process_single_archive(raw)
        failed = [result.error_message for result in results if not result.success]
        if failed:
            raise SystemExit(f"整理が失敗した: {failed}")
        built = results[0].output_path
        # 素材が本当に「整理が作る物」であることをここで固定する。名前の作り方が
        # 変われば組み立てが落ち、以降のテストが黙って別物を試すことがなくなる
        expected = f"{series} 第{volume:03d}巻.zip"
        if built.name != expected or built.parent.name != series:
            raise SystemExit(f"整理の出力が想定と違う: {built}")
        made.append(built)
    return made


shelf_books = build("A", shelf_author, shelf_title)
other_books = build("B", other_author, other_title)

# 整理済みの本を丸ごと蔵書へ複製する。複製でも判定は整理済みのまま
shutil.copytree(organized_root, library, dirs_exist_ok=True)
shelf_series = f"[{shelf_author}] {shelf_title}"
other_series = f"[{other_author}] {other_title}"
in_library = [library / book.parent.name / book.name for book in shelf_books + other_books]
missing = [str(book) for book in in_library if not book.exists()]
if missing:
    raise SystemExit(f"蔵書への複製が出来ていない: {missing}")

# 同梱物だけが違う。名前・置き場所・ページの並びは整理済みのまま
extra = copy_into(in_library[0], library / shelf_series, f"{shelf_series} 第006巻.zip")
with zipfile.ZipFile(extra, "a", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("readme.txt", b"hello")

print(
    json.dumps(
        {
            "organized": str(in_library[0]),
            "organizedOthers": [str(book) for book in in_library[1:]],
            "organizedOnly": [str(book) for book in shelf_books + other_books],
            "shelfSeries": shelf_series,
            "otherSeries": other_series,
            # 名前だけが整理の作る形と違う。まだ整理していない本の普通の姿
            "nameMismatch": str(zip_with(library / shelf_series / "raw_09.zip", sheets())),
            # 003 が抜けて 004 が居る。枚数は合うので数えるだけでは気づけない
            "pagesMismatch": str(
                zip_with(
                    library / shelf_series / f"{shelf_series} 第005巻.zip",
                    sheets(names=["001.jpg", "002.jpg", "004.jpg"]),
                )
            ),
            "extraEntries": str(extra),
            # 中身も名前も整理済みのまま、置いてあるフォルダだけが違う
            "folderMismatch": str(
                copy_into(in_library[0], library / "その他", f"{shelf_series} 第007巻.zip")
            ),
            # 1 つの ZIP から 2 冊。この道具の成果物はファイルなので整理済みにならない
            "compound": str(
                zip_with(library / "合本.zip", {**sheets("第01巻/"), **sheets("第02巻/")})
            ),
            # 蔵書の外に 1 つだけ置く、まだ整理していないアーカイブ
            "loose": str(zip_with(root / loose_name, sheets())),
        },
        ensure_ascii=False,
    )
)
`;

type Library = {
  /** 放り込むフォルダ。整理済みと未整理が混ざっている */
  folder: string;
  /** 整理済みの本しか入っていないフォルダ */
  organizedFolder: string;
  /** 蔵書の中の、整理済みの本 1 冊目 */
  organized: string;
  /** 蔵書の中の、残りの整理済みの本 */
  organizedOthers: string[];
  /** `整理済み/` の中の 4 冊 */
  organizedOnly: string[];
  /** 作品フォルダの名前 */
  shelfSeries: string;
  otherSeries: string;
  nameMismatch: string;
  pagesMismatch: string;
  extraEntries: string;
  folderMismatch: string;
  compound: string;
  /** 蔵書の外に置いた、まだ整理していないアーカイブ */
  loose: string;
};

let sidecar: Sidecar;
let library: Library;

/** 一度整理した蔵書に、整理済みでない本が混ざった状態を作る */
function buildLibrary(): Library {
  const folder = join(sidecar.workDir, LIBRARY_NAME);
  const organizedFolder = join(sidecar.workDir, ORGANIZED_NAME);
  mkdirSync(folder, { recursive: true });
  const scriptPath = join(sidecar.workDir, "make_organized_library.py");
  writeFileSync(scriptPath, FIXTURE_SCRIPT);
  const output = execFileSync(
    "uv",
    [
      "run",
      "python",
      scriptPath,
      sidecar.workDir,
      LIBRARY_NAME,
      ORGANIZED_NAME,
      SHELF_AUTHOR,
      SHELF_TITLE,
      OTHER_AUTHOR,
      OTHER_TITLE,
      LOOSE_NAME,
      ...ORGANIZED_VOLUMES.map(String),
    ],
    { cwd: CORE_DIR, encoding: "utf8" },
  );
  return {
    folder,
    organizedFolder,
    ...JSON.parse(output.trim().split("\n").pop()!),
  };
}

test.beforeAll(async () => {
  sidecar = await startSidecar();
  library = buildLibrary();
});

test.afterAll(() => sidecar?.stop());

/** 蔵書の中の整理済み 4 冊 */
function allOrganized(): string[] {
  return [library.organized, ...library.organizedOthers];
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

/** ファイル参照から、蔵書を丸ごと 1 回で投入する */
async function addLibraryFolder(page: Page) {
  await addFolder(page, LIBRARY_NAME);
}

/** 本の行が出そろうまで待つ。解析は往復を挟むので、待たずに読むと空になる */
async function waitForBooks(page: Page, count: number) {
  await expect(
    page.locator('[data-testid="plan-row"][data-kind="book"]'),
    "解析した本が一覧に出ていない",
  ).toHaveCount(count, { timeout: 60_000 });
}

/** 出力先を決めて整理の画面を開く。左の列はまだ空のまま */
async function openPlan(page: Page, name: string): Promise<string> {
  const output = join(sidecar.workDir, `out-${name}`);
  mkdirSync(output, { recursive: true });
  await openOrganize(page, output);
  await stubNoSuggestions(page);
  return output;
}

/**
 * 投入 → 解析まで済ませた状態を作る。
 *
 * 左の列には蔵書の中身と違う作品名・著者を入れる。判定が依頼の値を見て
 * いるなら、整理済みの本はここで整理済みでなくなる。
 */
async function preparePlan(page: Page, name: string): Promise<string> {
  const output = await openPlan(page, name);
  await page.getByTestId("organize-title").fill(FORM_TITLE);
  await page.getByTestId("organize-author").fill(FORM_AUTHOR);
  await expect(page.getByTestId("organize-author")).toHaveValue(FORM_AUTHOR);
  await addLibraryFolder(page);
  await waitForBooks(page, BOOK_COUNT);
  return output;
}

/**
 * 整理済みの本だけが入ったフォルダを、左の列を空のまま投入する。
 *
 * 左の列を埋めないのは、段階 4b の要が「残した本が全部自分の名前を持つなら
 * 左の列は要らない」ことだから。埋めてしまうと、名前を本ごとに持ち回らず
 * 左の列で作り直す実装でも同じ結果になる。
 */
async function prepareOrganizedOnly(page: Page, name: string): Promise<string> {
  const output = await openPlan(page, name);
  await addFolder(page, ORGANIZED_NAME);
  await waitForBooks(page, ORGANIZED_COUNT);
  return output;
}

/**
 * 本の行。元になったアーカイブで引く。
 *
 * 出来上がる名前で引かないのは、名前が左の列の作品名・著者から組み立て直され、
 * 段階 4a で本ごとの名前に変わったため。素材との対応は元パスで固定する。
 */
function bookRow(page: Page, source: string, entry = ""): Locator {
  return page.locator(
    `[data-testid="plan-row"][data-kind="book"]` +
      `[data-source="${source}"][data-entry="${entry}"]`,
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

/**
 * その行を入れた状態にする。
 *
 * 既定がどちらでも同じ状態に落ち着かせる。既定そのものは別のテストが
 * 受け持つので、ここで「外れていること」まで前提にすると、既定を裏返す
 * 前の実装では下ごしらえで落ちてしまい、そのテストが何を主張しているのか
 * 分からなくなる。
 */
async function keepRow(row: Locator) {
  const check = checkOf(row);
  if ((await check.getAttribute("aria-checked")) !== "true")
    await check.click();
  await expect(check, "行を入れた状態にできない").toHaveAttribute(
    "aria-checked",
    "true",
  );
}

/** 一覧の全部を入れた状態にする。`keepRow` と同じ理由で、既定は前提にしない */
async function keepEverything(page: Page) {
  const master = page.getByTestId("plan-master-check");
  if ((await master.getAttribute("aria-checked")) !== "true")
    await master.click();
  await expect(master, "全体のチェックで全部が入らない").toHaveAttribute(
    "aria-checked",
    "true",
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

/** 出来上がるはずのファイル名。組み立て方は VolumeDetector と同じ */
function volumeName(author: string, title: string, volume: number): string {
  return `[${author}] ${title} 第${String(volume).padStart(3, "0")}巻.zip`;
}

/**
 * 出力先に実際に出来た本を、フォルダ → ファイル名の対応として読み取る。
 *
 * 名前だけを並べると、2 作ぶんの名前が出ていれば置き場所が入れ替わっていても
 * 通ってしまう。どのフォルダに何が入ったかまで見る。
 */
function producedTree(root: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true, encoding: "utf8" });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const parts = entry.split("\\").join("/").split("/");
    const name = parts.pop()!;
    if (!name.endsWith(".zip")) continue;
    const folder = parts.join("/");
    (found[folder] ??= []).push(name);
  }
  for (const names of Object.values(found)) names.sort();
  return found;
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

    // Assert - 印が付いた本の行は整理済みの冊数ちょうど。全部の行に付ける
    // 実装では印そのものが意味を失う
    await expect(
      page.locator(
        '[data-testid="plan-row"][data-kind="book"] [data-testid="plan-row-state"]',
      ),
      "整理済みバッジが整理済みでない行にも付いている",
    ).toHaveCount(ORGANIZED_COUNT);
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

    // Assert - 種類だけでなく、どのページが何と違うのかまで読める（#126）。
    // 「連番が違います」とだけ言われても、利用者には違いを見つけようがない
    await expect(
      bookRow(page, library.pagesMismatch).getByTestId("plan-row-reason"),
      "連番の違いの中身が説明に出ていない",
    ).toHaveAttribute("title", /3 枚目が 004\.jpg（連番なら 003\.jpg）/);

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
    ).toBe(BOOK_COUNT - ORGANIZED_COUNT);

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

  test("整理済みの本だけが既定で外れ、行はそのまま残る", async ({ page }) => {
    // Arrange / Act
    await preparePlan(page, "既定で外れる");

    // Assert - 行の数は増えも減りもしない。整理済みの本を一覧から消すと、
    // 「作らない」ことと「見つからなかった」ことが区別できなくなる。
    // ここは第 3 段階から変えない
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
    await expect(
      page.getByTestId("plan-check"),
      "チェックが無い行がある",
    ).toHaveCount(ROW_COUNT);

    // Assert - 前提。判定が画面まで届いていること。整理済みが 1 冊も無い
    // 蔵書なら「整理済みが外れている」は何も確かめたことにならない
    await expect(
      page.locator('[data-testid="plan-row"][data-organized="true"]'),
      "整理済みと判定された行が揃っていない",
    ).toHaveCount(ORGANIZED_COUNT);

    // Assert - 整理済みの本は 4 冊とも既定でオフ
    for (const source of allOrganized()) {
      await expect(
        checkOf(bookRow(page, source)),
        `整理済みの本が既定で外れていない: ${source}`,
      ).toHaveAttribute("aria-checked", "false");
    }

    // Assert - 対照。整理済みでない本は 6 冊とも既定でオンのまま。
    // 「全部オフ」にする実装も「整理済みを見て何かした」ことにはなるが、
    // 一度も整理していない蔵書が丸ごと作られなくなる
    for (const source of [
      library.nameMismatch,
      library.pagesMismatch,
      library.extraEntries,
      library.folderMismatch,
    ]) {
      await expect(
        checkOf(bookRow(page, source)),
        `整理済みでない本まで既定で外れている: ${source}`,
      ).toHaveAttribute("aria-checked", "true");
    }
    for (const entry of ["第01巻", "第02巻"]) {
      await expect(
        checkOf(bookRow(page, library.compound, entry)),
        `合本の ${entry} まで既定で外れている`,
      ).toHaveAttribute("aria-checked", "true");
    }

    // Assert - 入れ物の三態は葉から決まる。整理済みの本しか持たない
    // アーカイブはオフ、そうでないアーカイブはオン、両方を含む蔵書は混在。
    // 入れ物にも状態を持たせて別々に決める実装はここで食い違う
    for (const source of allOrganized()) {
      await expect(
        checkOf(archiveRow(page, source)),
        `整理済みの本しか持たないアーカイブが外れていない: ${source}`,
      ).toHaveAttribute("aria-checked", "false");
    }
    await expect(
      checkOf(archiveRow(page, library.compound)),
      "整理済みを 1 冊も持たないアーカイブまで外れている",
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      checkOf(folderRow(page, library.folder)),
      "整理済みと未整理が混ざったフォルダが混在になっていない",
    ).toHaveAttribute("aria-checked", "mixed");
    await expect(
      page.getByTestId("plan-master-check"),
      "全体のチェックが混在になっていない",
    ).toHaveAttribute("aria-checked", "mixed");

    // Assert - 作る冊数も整理済みのぶんだけ減る
    await expect(
      page.getByTestId("organize-status"),
      "作る冊数に整理済みのぶんが残っている",
    ).toContainText(`${DEFAULT_KEPT} 冊を作ります`);
  });

  test("状態の行は「外した」と「整理済み」を別々に数える", async ({ page }) => {
    // Arrange / Act
    await preparePlan(page, "件数の言い分け");
    const status = page.getByTestId("organize-status");

    // Assert - 何も触っていない状態。整理済みを「外した」に混ぜて数える
    // 実装でも、片方だけを見れば「もっともらしい 1 文」が出てしまう。
    // 出ている言葉と、出ていない言葉の両方を見る
    await expect(
      status,
      "整理済みのぶんが別の言葉で数えられていない",
    ).toHaveText(
      `${DEFAULT_KEPT} 冊を作ります · ${ORGANIZED_COUNT} 冊は整理済みなので作りません`,
    );
    await expect(
      status,
      "何も外していないのに、整理済みが「外した」に数えられている",
    ).not.toContainText("外した");

    // Assert - 状態の行は 1 行に収める。溢れる分は行に乗せると読める。
    // 説明が無いと、なぜ作られないのかを画面から知る手立てが無くなる
    const tip = await status.getAttribute("title");
    expect(tip ?? "", "状態の行に説明が無い").not.toBe("");
    expect(
      tip ?? "",
      `説明が「出力先には作らない」ことを言っていない: ${tip}`,
    ).toContain("出力先");

    // Act - 整理済みでない本を 1 冊外す
    await checkOf(bookRow(page, library.nameMismatch)).click();
    await expect(
      checkOf(bookRow(page, library.nameMismatch)),
      "外したはずの本にチェックが残っている",
    ).toHaveAttribute("aria-checked", "false");

    // Assert - 3 つの数が同時に出る。利用者が外した 1 冊と、整理済みだから
    // 作らない 4 冊は別の理由なので、同じ言葉で数えてはいけない
    const kept = DEFAULT_KEPT - 1;
    await expect(status, "3 つの内訳が同時に出ていない").toHaveText(
      `${kept} 冊を作ります · 1 冊を外した` +
        ` · ${ORGANIZED_COUNT} 冊は整理済みなので作りません`,
    );

    // Assert - 3 つで本の行を過不足なく分け合っている。数え方を画面が
    // 出した文字から読み直すのは、期待値どうしを足しても何も確かめられない
    // ため。どれかに二重に数えられた本があると、ここで合計が合わなくなる
    const shown = (await status.textContent()) ?? "";
    const counted = [...shown.matchAll(/(\d+)\s*冊/g)].map((found) =>
      Number(found[1]),
    );
    expect(counted, `内訳が 3 つ読めない: ${shown}`).toHaveLength(3);
    expect(
      counted.reduce((total, count) => total + count, 0),
      `作る・外した・整理済みの合計が本の冊数と合わない: ${shown}`,
    ).toBe(BOOK_COUNT);
  });

  test("入れ直した整理済みの本は、解析をやり直しても入ったまま", async ({
    page,
  }) => {
    // Arrange - 整理済みだけの蔵書
    await prepareOrganizedOnly(page, "解析のやり直し");
    const [rechecked, untouched] = library.organizedOnly;
    // 前提。2 冊とも整理済みとして届いていること。整理済みでない本で
    // 試すと、以下の主張は「既定のオンがそのまま残った」だけになる
    for (const source of [rechecked, untouched]) {
      await expect(
        bookRow(page, source),
        `整理済みとして届いていない: ${source}`,
      ).toHaveAttribute("data-organized", "true");
    }

    // Act - 1 冊だけ入れ直す。もう 1 冊には指一本触れない
    await keepRow(bookRow(page, rechecked));

    // Act - 投入を足す。投入が変われば解析はやり直しになり、行は組み直される
    await addArchive(page, LOOSE_NAME);
    await waitForBooks(page, ORGANIZED_COUNT + 1);

    // Assert - 入れ直した 1 冊は入ったまま。行を組み直すたびに既定へ
    // 戻す実装（覚えている側を書き換える実装）はここで落ちる
    await expect(
      checkOf(bookRow(page, rechecked)),
      "入れ直した整理済みの本が、解析のやり直しで外れた",
    ).toHaveAttribute("aria-checked", "true");

    // Assert - 触っていない整理済みの本は外れたまま。行が生えるたびに
    // 整理済みを「外した」として覚え込む実装だと、上の 1 行は通るのに
    // ここが通らない。逆に既定へ戻す実装は上で落ちる。両方を見る
    await expect(
      checkOf(bookRow(page, untouched)),
      "触っていない整理済みの本が入ってしまった",
    ).toHaveAttribute("aria-checked", "false");

    // Assert - 後から足した整理済みでない本は、いままでどおり既定でオン
    await expect(
      checkOf(bookRow(page, library.loose)),
      "後から足した整理済みでない本が既定で外れている",
    ).toHaveAttribute("aria-checked", "true");
  });

  test("入れ直した整理済みの本は、左の列が空でも自分の名前で作られる", async ({
    page,
  }) => {
    // Arrange - 整理済みだけの蔵書。左の列は空のまま
    const output = await prepareOrganizedOnly(page, "自分の名前で作る");

    // 辞書への記録が投入されないことも見る。作品名が空のまま送ると
    // サイドカーは 400 で断り、その失敗は握りつぶされて誰にも見えない
    const posted: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      posted.push(new URL(request.url()).pathname);
    });

    // Act - 全部を入れ直す
    await keepEverything(page);

    // Assert - 左の列が空のままでも実行できる。残した本はどれも自分の名前を
    // 持っているので、左の列の対はどこにも使われない
    await expect(page.getByTestId("organize-title")).toHaveValue("");
    await expect(page.getByTestId("organize-author")).toHaveValue("");
    await expect(
      page.getByTestId("confirm"),
      "残した本が全部自分の名前を持つのに、左の列を求められる",
    ).toBeEnabled();

    // Act
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 60_000 },
    );

    // Assert - 2 つの作品フォルダに 2 冊ずつ。名前だけを数えると、置き場所が
    // 入れ替わっていても通ってしまうので、フォルダとの対応で見る。左の列の
    // 対で作り直す実装では、フォルダが 1 つ（あるいは `[] ` で始まるもの）に
    // なってここで落ちる
    expect(
      producedTree(output),
      "整理済みの本が自分の名前・自分の作品フォルダへ作られていない",
    ).toEqual({
      [library.shelfSeries]: ORGANIZED_VOLUMES.map((volume) =>
        volumeName(SHELF_AUTHOR, SHELF_TITLE, volume),
      ).sort(),
      [library.otherSeries]: ORGANIZED_VOLUMES.map((volume) =>
        volumeName(OTHER_AUTHOR, OTHER_TITLE, volume),
      ).sort(),
    });

    // Assert - 空の作品名を辞書へ記録しに行かない。送れば断られるだけで、
    // その失敗は握りつぶされる（利用者には何も起きていないように見える）
    expect(posted, "作品名が空のまま辞書へ記録しに行っている").not.toContain(
      "/api/library/entries",
    );
  });

  test("作品名と著者は、自分の名前を持たない本が残っているときだけ要る", async ({
    page,
  }) => {
    // Arrange - 整理済みだけの蔵書。左の列は空のまま
    await prepareOrganizedOnly(page, "名前が要るとき");
    const status = page.getByTestId("organize-status");
    const confirm = page.getByTestId("confirm");

    // Assert - 分岐 C。既定は全部オフなので作る本が無い。ここで
    // 「作品名を入れてください」と言うと、使われもしない作品名を打たせる
    // ことになる。作る本が無いことのほうが先に立つ
    await expect(status, "作る本が無いことが読めない").toHaveText(
      `${ORGANIZED_COUNT} 冊はすべて整理済みなので作りません` +
        ` · 出力先にも作るならチェックを入れてください`,
    );
    await expect(
      confirm,
      "作る本が 1 冊も無いのに実行できてしまう",
    ).toBeDisabled();

    // Act - 分岐 A。全部を入れ直す
    await keepEverything(page);

    // Assert - 残した本が全部自分の名前を持つなら、左の列は空でも実行できる。
    // 「常に作品名が要る」実装はここで落ちる
    await expect(status, "作る冊数が出ていない").toHaveText(
      `${ORGANIZED_COUNT} 冊を作ります`,
    );
    await expect(
      confirm,
      "自分の名前を持つ本しか残っていないのに、左の列を求められる",
    ).toBeEnabled();

    // Act - 分岐 B。自分の名前を持たない本を 1 冊足す
    await addArchive(page, LOOSE_NAME);
    await waitForBooks(page, ORGANIZED_COUNT + 1);
    await expect(
      checkOf(bookRow(page, library.loose)),
      "後から足した本が既定でオンになっていない",
    ).toHaveAttribute("aria-checked", "true");

    // Assert - 名前を持たない本が 1 冊でも残っていれば、左の列が要る。
    // 「名前は要らない」に倒した実装だと、その本は `[] .zip` になって出る。
    // 文言を先に見るのは、解析中もボタンは押せないため。「押せない」だけを
    // 見ると、解析が終わる前に通ってしまい何も確かめたことにならない
    await expect(status, "何を入れればよいのかが読めない").toContainText(
      "作品名",
    );
    await expect(
      confirm,
      "自分の名前を持たない本が残っているのに、左の列なしで実行できる",
    ).toBeDisabled();
  });

  test("作品情報の見出しに、左の列が何に使われるかが出る", async ({ page }) => {
    // Arrange - 何も入れていない最初の画面。まだ意味の定まらない 2 つの欄が
    // 最初に目に入るので、欄の役目を先に言う（サイドバー案 段階 6）
    await openPlan(page, "見出しの説明");
    const hint = page.getByTestId("organize-name-hint");
    await expect(
      hint,
      "何も入れていないときに欄の役目を言っていない",
    ).toHaveText("出来上がる本の名前に使います");
    const emptyHeight = (await page.getByTestId("series-info").boundingBox())!
      .height;

    // Act - 整理済みが 1 冊も無い投入
    await addArchive(page, LOOSE_NAME);
    await waitForBooks(page, 1);

    // Assert - 整理済みでない本の数を言う。文言が替わっても高さは変わらない
    await expect(
      page.locator('[data-testid="plan-row"][data-organized="true"]'),
      "整理済みの行が混ざっている",
    ).toHaveCount(0);
    await expect(hint).toHaveText("整理済みでない 1 冊の名前に使います");
    expect(
      Math.abs(
        (await page.getByTestId("series-info").boundingBox())!.height -
          emptyHeight,
      ),
      "文言が替わると作品情報の高さが変わる",
    ).toBeLessThan(1);

    // Act - 整理済みと未整理が混ざった蔵書を足す
    await addLibraryFolder(page);
    await waitForBooks(page, BOOK_COUNT + 1);

    // Assert - 左の列は「残した本のうち、自分の名前を持たないもの」に使われる。
    // 整理済みのぶんを数に入れる実装はここで落ちる
    await expect(
      page.getByTestId("organize-name-hint"),
      "左の列が何冊に使われるのかが読めない",
    ).toHaveText(`整理済みでない ${DEFAULT_KEPT + 1} 冊の名前に使います`);
  });

  test("作る本が全部整理済みなら、作品情報は今は使わないと出る", async ({
    page,
  }) => {
    // Arrange - 整理済みだけの蔵書。既定は全部オフ
    await prepareOrganizedOnly(page, "見出しの今は使いません");
    const hint = page.getByTestId("organize-name-hint");

    // Assert - 作る本が無い。左の列を打っても何も起きないことを先に伝える
    await expect(hint, "作る本が無いことが見出しから読めない").toHaveText(
      "作る本がないので使いません",
    );

    // Act - 全部を入れ直す
    await keepEverything(page);

    // Assert - 残した本は全部自分の名前を持つ。同じ「今は使いません」でも
    // 理由が違うので、後ろに続く言葉を変える。1 種類しか出さない実装は
    // どちらか片方で落ちる
    await expect(hint, "使わない理由が読み分けられない").toHaveText(
      "作る本は全部整理済みなので使いません",
    );
  });
});

/**
 * 行の中の見え方を仕上げる（#73 段階 4c）。
 *
 * 段階 4b までで、整理済みの本は既定で外れ、行は消えずに残り、入れ直せば
 * 自分の名前で作られるようになった。残っているのは行そのものの見え方で、
 * 直すのは次の 3 つ。
 *
 * - **薄めるのを `li` から中の子へ移す。** いまは行を丸ごと 45% にしている。
 *   すると「整理済み」の印まで薄くなる。その印はこの行が外れている理由
 *   そのものなので、利用者から見ると答えの側が読みにくくなる。チェックと
 *   整理済みの印と近道は 100% のまま残し、名前・場所・絵・理由の印だけを
 *   薄める。行に乗せている間（ホバー・焦点）は全部 100% に戻す
 * - **入れ直した整理済みの行は、行き先を出す。** 外れている間は今までどおり
 *   元を指す。入れ直したときだけ「どこへ作られるのか」に変える。整理済みの
 *   本は元の場所も出来上がる形も同じなので、行き先を出さないと入れ直した
 *   ことが行から読めない
 * - **整理済みの行にだけ、次の作業への近道を置く。** 整理済みの本は既に
 *   ディスク上に最終形で在るので、整理を待たずにそのまま開ける。行き先は
 *   出来たファイルの一覧（`ProducedList`）と同じ 2 つで、同じ受け渡し
 *   （`onOpenProduced` → `App.openArchiveIn`）を通る。各画面は今までどおり
 *   単独で使えるのが主で、これは任意の近道でしかない
 *
 * ここで足りない画面の契約は次のとおり。
 *
 * - `data-dim`       … 薄める側に回る子に付ける印。行がオフのときだけ効く
 * - `plan-row-name`  … 行に出す名前（薄める側）
 * - `plan-row-path`  … 名前の隣。オフなら元、オンの整理済みなら行き先（薄める側）
 * - `plan-to-thumbnail` / `plan-to-reorder`
 *                    … 整理済みの行にだけ置く近道。薄めない
 */
test.describe("整理済みの行の仕上げ", () => {
  /** 薄めた側の不透明度。Tailwind の `opacity-45` が出す値 */
  const DIMMED = "0.45";

  /** 薄めない側の不透明度 */
  const FULL = "1";

  /** 画面に実際に効いている不透明度を読む */
  async function opacityOf(target: Locator): Promise<string> {
    return target.evaluate((node) => getComputedStyle(node).opacity);
  }

  /**
   * その要素自身か、上のどれかが薄める側に回っているか。
   *
   * 不透明度だけでは足りない。親に `opacity` を掛けても、子の
   * `getComputedStyle` は 1 のままを返す（見た目は薄いのに 1 と読める）。
   * 薄める印そのものを辿って、薄めない子が巻き込まれていないか見る。
   */
  async function inDimmed(target: Locator): Promise<boolean> {
    return target.evaluate((node) => node.closest("[data-dim]") !== null);
  }

  /**
   * 行からホバーと焦点を外す。
   *
   * どちらも薄めを解くので、読む前に必ず離す。離さずに読むと「薄まって
   * いない」がホバーのせいなのか実装のせいなのか分からなくなる。
   */
  async function leaveRows(page: Page) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement) focused.blur();
    });
  }

  /** 行の名前。薄める側 */
  function nameOf(row: Locator): Locator {
    return row.getByTestId("plan-row-name");
  }

  /** 行の場所。薄める側で、入れ直した整理済みの行だけ行き先に変わる */
  function pathOf(row: Locator): Locator {
    return row.getByTestId("plan-row-path");
  }

  /** 入れ直した整理済みの行が指す行き先 */
  function destination(output: string, series: string): string {
    return `→ ${output}/${series}/`;
  }

  /** 本の行が外れているときに出る、元の場所の文言（4b までと同じ） */
  const ORIGIN_WHOLE = "← アーカイブ全体";

  test("外した行で薄まるのは中の子だけで、チェックと整理済みの印は薄まらない", async ({
    page,
  }) => {
    // Arrange
    await preparePlan(page, "行の薄め方");
    await leaveRows(page);
    const row = bookRow(page, library.organized);
    await expect(
      checkOf(row),
      "整理済みの行が既定で外れていない（前提が崩れている）",
    ).toHaveAttribute("aria-checked", "false");

    // Assert - 行そのものは薄めない。ここが要。`li` に不透明度を掛けると
    // 中の子は軒並み 1 と読めてしまうので、「チェックが 1 だ」のような
    // 子 1 つの主張は行を丸ごと薄めている今の実装でも通る。行が 1 で
    // あることだけが「薄めが子へ移った」ことを言える
    expect(
      await opacityOf(row),
      "行そのものが薄まっている（薄めが li に掛かったままになっている）",
    ).toBe(FULL);

    // Assert - 薄まるのは名前と場所。何を外したのかは読めるが、目立たない
    for (const [what, target] of [
      ["名前", nameOf(row)],
      ["場所", pathOf(row)],
    ] as const) {
      await expect(
        target,
        `行の${what}が読み取れない（plan-row-name / plan-row-path が無い）`,
      ).toHaveCount(1);
      expect(await opacityOf(target), `外した行の${what}が薄まっていない`).toBe(
        DIMMED,
      );
    }

    // Assert - チェックと整理済みの印は 100% のまま。印はこの行が外れて
    // いる理由そのもので、一緒に薄めると「なぜ外れているのか」の答えが
    // 一番読みにくい所に置かれることになる
    for (const [what, target] of [
      ["チェック", checkOf(row)],
      ["整理済みの印", row.getByTestId("plan-row-state")],
    ] as const) {
      expect(await opacityOf(target), `外した行の${what}が薄まっている`).toBe(
        FULL,
      );
      expect(
        await inDimmed(target),
        `外した行の${what}が薄める側に入っている`,
      ).toBe(false);
    }

    // Act - 行に乗せる
    await row.hover();

    // Assert - 乗せている間は行ごと 100% に戻る。外した行でも、読みたい
    // ときには読める。ここで名前だけを見ても意味が無い（薄めが li に
    // 残っていても子は 1 と読める）ので、行と名前の両方を見る
    expect(await opacityOf(row), "行に乗せても行が薄いまま").toBe(FULL);
    expect(await opacityOf(nameOf(row)), "行に乗せても名前が薄いまま").toBe(
      FULL,
    );

    // Act - 離す
    await leaveRows(page);

    // Assert - 離せば薄まりに戻る。乗せたきり戻らない実装だと、一度触った
    // 行だけが濃く残り、どれを外したのか一覧から読めなくなる
    expect(await opacityOf(nameOf(row)), "行から離れても薄まりに戻らない").toBe(
      DIMMED,
    );

    // Assert - 対照 1。入っている行は薄めない。全部の行を薄める実装は
    // ここで落ちる
    expect(
      await opacityOf(nameOf(bookRow(page, library.nameMismatch))),
      "入っている行まで薄まっている",
    ).toBe(FULL);

    // Assert - 対照 2。入れ物も三態が false なら薄まる（4b までと同じ）。
    // 薄めを本の行だけに付ける実装だと、外れた入れ物が濃いまま残る
    const container = archiveRow(page, library.organized);
    expect(
      await opacityOf(container),
      "入れ物そのものが薄まっている（薄めが li に掛かったままになっている）",
    ).toBe(FULL);
    expect(
      await opacityOf(nameOf(container)),
      "外れている入れ物の名前が薄まっていない",
    ).toBe(DIMMED);

    // Assert - 対照 3。混在の入れ物は薄めない。false のときだけ薄める
    expect(
      await opacityOf(nameOf(folderRow(page, library.folder))),
      "混在の入れ物まで薄まっている",
    ).toBe(FULL);

    // Act - 利用者が自分で外した行。整理済みではないので理由の印が出ている
    const dropped = bookRow(page, library.folderMismatch);
    await checkOf(dropped).click();
    await leaveRows(page);
    await expect(
      checkOf(dropped),
      "外したはずの行にチェックが残っている",
    ).toHaveAttribute("aria-checked", "false");

    // Assert - 理由の印は薄める側。整理済みの印と違い、これは「まだ直せる」
    // という手掛かりで、外した行では急ぎの用ではない
    expect(
      await opacityOf(dropped.getByTestId("plan-row-reason")),
      "外した行の理由の印が薄まっていない",
    ).toBe(DIMMED);
    expect(
      await opacityOf(checkOf(dropped)),
      "自分で外した行のチェックまで薄まっている",
    ).toBe(FULL);
  });

  test("入れ直した整理済みの行は、元の場所ではなく行き先を出す", async ({
    page,
  }) => {
    // Arrange - 左の列には蔵書と違う対が入る。行き先を左の列から組み立てる
    // 実装なら、ここで別の作品フォルダが出て落ちる
    const output = await preparePlan(page, "行き先");
    const row = bookRow(page, library.organized);
    await expect(
      checkOf(row),
      "整理済みの行が既定で外れていない（前提が崩れている）",
    ).toHaveAttribute("aria-checked", "false");

    // Assert - 外れている間は今までどおり元を指す。行き先を常に出す実装でも
    // 「入れ直したら行き先が出る」だけは通ってしまうので、両方を見る
    await expect(row, "外れている整理済みの行が元を指していない").toContainText(
      ORIGIN_WHOLE,
    );
    expect(
      await row.textContent(),
      "外れているのに行き先が出ている",
    ).not.toContain(output);

    // Act
    await keepRow(row);

    // Assert - 入れ直すと行き先に変わる。整理済みの本は元の場所も出来上がる
    // 形も同じなので、行き先を出さないと入れ直したことが行から読めない
    await expect(
      row,
      "入れ直した整理済みの行に行き先が出ていない",
    ).toContainText(destination(output, library.shelfSeries));

    // Assert - 行き先は場所の欄が持つ。名前の後ろに足すだけだと、行ごとに
    // 名前の幅が変わって一覧が読みにくくなる
    const where = pathOf(row);
    await expect(
      where,
      "場所の欄が読み取れない（plan-row-path が無い）",
    ).toHaveCount(1);
    await expect(where, "場所の欄が行き先だけを出していない").toHaveText(
      destination(output, library.shelfSeries),
    );
    // 元を指すときより 1 段濃くする。行き先はこれから起きることで、
    // 済んだ場所より先に読ませたい
    await expect(where, "行き先が text-ink-muted になっていない").toHaveClass(
      /\btext-ink-muted\b/,
    );

    // Assert - 別の作品の行は別の作品フォルダを指す。1 つの対で全部の行き先を
    // 作る実装や、先頭の本の名前を使い回す実装はここで落ちる
    const other = bookRow(page, library.organizedOthers[1]);
    await keepRow(other);
    await expect(pathOf(other), "作品ごとに行き先が分かれていない").toHaveText(
      destination(output, library.otherSeries),
    );

    // Act - もう一度外す
    await checkOf(row).click();
    await expect(
      checkOf(row),
      "外したはずの行にチェックが残っている",
    ).toHaveAttribute("aria-checked", "false");

    // Assert - 外し直せば元へ戻る。一度オンにしたら戻らない実装だと、作らない
    // 本の行が作られる場所を指したままになる
    await expect(where, "外し直したのに行き先のまま").toHaveText(ORIGIN_WHOLE);

    // Assert - 対照。整理済みでない本は、入っていても元を指したまま。
    // その本はまだディスク上に無く、行き先だけを出すと、既に在るかのように読める。
    // 元は「元の名前 → 出来上がる名前」の元の欄に出る（段階 5）
    await expect(
      checkOf(bookRow(page, library.nameMismatch)),
      "整理済みでない本が入っていない（前提が崩れている）",
    ).toHaveAttribute("aria-checked", "true");
    const messyWhere = pathOf(bookRow(page, library.nameMismatch));
    await expect(messyWhere, "整理済みでない本の元が出ていない").toContainText(
      library.nameMismatch.split("/").pop()!,
    );
    await expect(
      messyWhere,
      "整理済みでない本まで行き先を出している",
    ).not.toContainText(output);
  });

  test("整理済みの行にだけ、次の作業への近道が出る", async ({ page }) => {
    // Arrange
    await preparePlan(page, "行の近道");
    await leaveRows(page);
    const row = bookRow(page, library.organized);
    const name = (await row.getAttribute("data-output-name")) ?? "";
    // 整理済みの本は既に最終形なので、出来上がる名前は今の名前と同じになる。
    // 説明に出す名前がこの 1 つで決まることを、先に押さえておく
    expect(name, "整理済みの行の名前が、そのファイルの名前と違う").toBe(
      library.organized.split("/").pop(),
    );

    // Assert - 出来たファイルの一覧（ProducedList）と同じ 3 つ（#143）。同じ
    // ことをする近道が画面ごとに違う顔をしていると、押す前に読み直すことになる。
    // アイコンだけにして、何をするかは乗せたときの説明で伝える
    for (const [testId, icon, tip] of [
      ["plan-to-thumbnail", "svg.lucide-image", `${name} のサムネイルを作る`],
      [
        "plan-to-reorder",
        "svg.lucide-list-ordered",
        `${name} のページを並べ替える`,
      ],
      [
        "plan-to-split",
        "svg.lucide-columns-2",
        `${name} のページを分割・結合する`,
      ],
    ] as const) {
      const button = row.getByTestId(testId);
      await expect(button, `整理済みの行に ${testId} が無い`).toHaveCount(1);
      await expect(
        button.locator(icon),
        `${testId} の絵が ProducedList と違う`,
      ).toHaveCount(1);
      await expect(
        button,
        `${testId} に、どの本を開くのかの説明が無い`,
      ).toHaveAttribute("title", tip);
      // 近道は薄めない。外れている行でも押せるものだと読めなくなる
      expect(await inDimmed(button), `${testId} が薄める側に入っている`).toBe(
        false,
      );
    }

    // Assert - 整理済みでない本には出さない。その本はまだディスク上に無く、
    // 押しても開くものが無い
    for (const [what, target] of [
      ["整理済みでない本", bookRow(page, library.nameMismatch)],
      ["アーカイブ", archiveRow(page, library.compound)],
      ["フォルダ", folderRow(page, library.folder)],
    ] as const) {
      await expect(
        target.getByTestId("plan-to-thumbnail"),
        `${what}の行にまで近道が出ている`,
      ).toHaveCount(0);
      await expect(
        target.getByTestId("plan-to-reorder"),
        `${what}の行にまで近道が出ている`,
      ).toHaveCount(0);
      await expect(
        target.getByTestId("plan-to-split"),
        `${what}の行にまで近道が出ている`,
      ).toHaveCount(0);
    }

    // Assert - 一覧全体でも整理済みの冊数ちょうど。全部の行に付ける実装は
    // ここで落ちる
    for (const testId of [
      "plan-to-thumbnail",
      "plan-to-reorder",
      "plan-to-split",
    ] as const) {
      await expect(
        page.getByTestId(testId),
        `${testId} が整理済み以外の行にも出ている`,
      ).toHaveCount(ORGANIZED_COUNT);
    }

    // Assert - 乗せる前から見えている。編集済みの印は、整理済みの印と同じく
    // 行を眺めただけで読めないと意味が無い（#143）
    expect(
      await opacityOf(row.getByTestId("plan-to-thumbnail")),
      "乗せないと近道が見えない",
    ).toBe(FULL);
  });

  test("整理済みの行の近道から、その本を読み込んだ画面へ移る", async ({
    page,
  }) => {
    // Arrange
    await preparePlan(page, "近道で移る");

    // Act - 先頭ではなく別の作品の 1 冊から移る。先頭を渡して済ませる実装や、
    // 出力先の 1 つ目を開く実装を落とす。行は外れたままにしておく
    const source = library.organizedOthers[1];
    const row = bookRow(page, source);
    await expect(
      checkOf(row),
      "整理済みの行が既定で外れていない（前提が崩れている）",
    ).toHaveAttribute("aria-checked", "false");
    const thumbnail = row.getByTestId("plan-to-thumbnail");
    await expect(thumbnail, "サムネイルの近道が無い").toHaveCount(1);
    await thumbnail.click();

    // Assert - 押した行のファイルが読み込まれた状態でサムネイル作成へ移る。
    // 画面だけ移ってファイルを選び直させると、近道の意味が無くなる
    await expect(page.getByTestId("mode-thumbnail")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      page.getByTestId("archive-name"),
      "移った先が別のファイルを読んでいる",
    ).toHaveText(source.split("/").pop()!);
    // ファイル整理は隠れるだけで残る（#67）ので、その中のドロップ領域も
    // DOM には居続ける。見えていないことで確かめる
    await expect(
      page.getByTestId("dropzone"),
      "移った先でファイルを選び直させている",
    ).toBeHidden();

    // Act - ファイル整理へ戻る
    await page.getByTestId("mode-organize").click();

    // Assert - 近道を押しただけでは、作る・作らないは動かない。押すたびに
    // 入れ直す実装だと、覗きに行っただけで出力先に本が増える
    await expect(
      checkOf(row),
      "近道を押しただけで行のチェックが動いた",
    ).toHaveAttribute("aria-checked", "false");

    // Act - もう一方の近道も、別の行から試す
    const another = library.organized;
    const reorder = bookRow(page, another).getByTestId("plan-to-reorder");
    await expect(reorder, "ページ並べ替えの近道が無い").toHaveCount(1);
    await reorder.click();

    // Assert
    await expect(page.getByTestId("mode-reorder")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      page.getByTestId("archive-name"),
      "移った先が別のファイルを読んでいる",
    ).toHaveText(another.split("/").pop()!);
    // 名前だけなら見出しを書き換えるだけでも通る。中身まで読めていることを
    // ページ数で確かめる（整理済みの本はどれも 3 ページ）
    await expect(
      page.getByTestId("page-card"),
      "移った先が中身まで読み込めていない",
    ).toHaveCount(3);
  });
});
