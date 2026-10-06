import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 整理済みの本が、自分の名前のまま画面を通ること（#73 段階 4a）。
 *
 * 段階 3 までで判定は画面に出たが、名前はまだ 3 つの側で別々に決まっている。
 *
 * | 側 | いまの振る舞い |
 * |---|---|
 * | `toc_analyzer._Planner._plan` | 整理済みなら `source.stem` を予告する |
 * | `FileOrganizer._process_volume` | 依頼の対（著者・作品名）で毎回作り直す |
 * | `plan.ts` の `outputNames` | 左の列の対で毎回組み直す |
 *
 * この 3 つ目がここの担当になる。サイドカーだけを直しても、画面が左の列から
 * 名前を組み直している限り、一覧には「作り直したら別人名義になる」という嘘の
 * 予告が並び、投入にも本ごとの名前が載らない。
 *
 * 左の列には蔵書の中身と**わざと違う**対を入れる。揃えると 3 つの側が同じ
 * 答えを出してしまい、食い違いはどこからも見えない。
 *
 * ここで求める画面の契約は次のとおり。
 *
 * - 整理済みの本の `data-output-name` は、その本自身の名前
 * - 左の列の作品名を変えても、整理済みの本の名前は動かない。整理済みでない
 *   本の名前は今までどおり追従する（往復なしで追従する原則は変えない）
 * - 実行すると、整理済みの本は自分の作品フォルダへ、それ以外は依頼の対の
 *   フォルダへ出来る
 *
 * サイドカー側の契約は `services/core/tests/test_organized_naming.py`。
 * ここは判定も名前も作り直さず、実際の整理に素材を作らせて画面まで運ぶ。
 */

const CORE_DIR = fileURLToPath(
  new URL("../../../services/core", import.meta.url),
);

/** 左の列に入れる作品名と著者。蔵書の中身と**わざと違える** */
const FORM_AUTHOR = "テスト著者";
const FORM_TITLE = "画面の作品";

/** 左の列で作品名を変えたあとの値。名前の追従を見るために使う */
const LATER_TITLE = "あとの作品";

/** 蔵書に入っている本の著者と作品名。整理済みの形はこの 2 つから決まる */
const SHELF_AUTHOR = "棚の著者";
const SHELF_TITLE = "棚の作品";
const SHELF_VOLUME = 3;

/** 蔵書に混ぜる、まだ整理していない本。名前の数字が巻数になる */
const PLAIN_VOLUME = 9;

/** 放り込むフォルダの名前 */
const LIBRARY_NAME = "蔵書";

/** 出来上がる本の数。整理済み 1 冊 + 整理済みでない 1 冊 */
const BOOK_COUNT = 2;

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
import sys
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from manga_core.file_organizer import FileOrganizer

library = Path(sys.argv[1])
author = sys.argv[2]
title = sys.argv[3]
volume = int(sys.argv[4])
plain_volume = int(sys.argv[5])
series = f"[{author}] {title}"
PAGE_COUNT = 3
FONT = ImageFont.load_default(size=120)


def page(label: str) -> bytes:
    canvas = Image.new("RGB", (600, 900), "#3366cc")
    ImageDraw.Draw(canvas).text((300, 450), label, font=FONT, anchor="mm", fill="white")
    buffer = io.BytesIO()
    canvas.save(buffer, "JPEG", quality=85)
    return buffer.getvalue()


def sheets() -> dict[str, bytes]:
    return {f"{index:03d}.jpg": page(f"{index:03d}") for index in range(1, PAGE_COUNT + 1)}


def zip_with(target: Path, entries: dict[str, bytes]) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return target


# 整理に作らせる。素材は蔵書の外に置く（走査に拾わせない）
raw = zip_with(library.parent / "素材" / f"素材_{volume:02d}.zip", sheets())
organizer = FileOrganizer(output_directory=library, keep_originals=True)
organizer.set_manga_info(author=author, title=title)
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

print(
    json.dumps(
        {
            "organized": str(built),
            # まだ整理していない本。名前は左の列の対から組み立てられる
            "plain": str(zip_with(library / f"raw_{plain_volume:02d}.zip", sheets())),
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
  /** まだ整理していない本 */
  plain: string;
};

let sidecar: Sidecar;
let library: Library;

/** 一度整理した蔵書に、整理済みでない本が 1 冊混ざった状態を作る */
function buildLibrary(): Library {
  const folder = join(sidecar.workDir, LIBRARY_NAME);
  mkdirSync(folder, { recursive: true });
  const scriptPath = join(sidecar.workDir, "make_named_library.py");
  writeFileSync(scriptPath, FIXTURE_SCRIPT);
  const output = execFileSync(
    "uv",
    [
      "run",
      "python",
      scriptPath,
      folder,
      SHELF_AUTHOR,
      SHELF_TITLE,
      String(SHELF_VOLUME),
      String(PLAIN_VOLUME),
    ],
    { cwd: CORE_DIR, encoding: "utf8" },
  );
  return { folder, ...JSON.parse(output.trim().split(/\r?\n/).pop()!) };
}

test.beforeAll(async () => {
  sidecar = await startSidecar();
  library = buildLibrary();
});

test.afterAll(() => sidecar?.stop());

/** 出来上がるはずのファイル名。組み立て方は VolumeDetector と同じ */
function volumeName(author: string, title: string, volume: number): string {
  return `[${author}] ${title} 第${String(volume).padStart(3, "0")}巻.zip`;
}

/** 作品フォルダの名前 */
function seriesDir(author: string, title: string): string {
  return `[${author}] ${title}`;
}

/**
 * 出力先に実際に出来た本を、フォルダ込みで読み取る。
 *
 * 名前だけを数えると、名前を差し替えて置き場所は依頼の対のまま、という
 * 実装が通ってしまう。フォルダまで見る。
 */
function producedPaths(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .map((entry) => entry.split("\\").join("/"))
      .filter((entry) => entry.endsWith(".zip"))
      .sort();
  } catch {
    return [];
  }
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

/** 作品名と著者を入れる。作品名を変えると著者が引き直されるので、著者は後 */
async function fillMangaInfo(page: Page, title: string) {
  await page.getByTestId("organize-title").fill(title);
  await page.getByTestId("organize-author").fill(FORM_AUTHOR);
  await expect(page.getByTestId("organize-author")).toHaveValue(FORM_AUTHOR);
}

/** 投入 → 解析まで済ませた状態を作る */
async function preparePlan(page: Page, name: string): Promise<string> {
  const output = join(sidecar.workDir, `out-${name}`);
  mkdirSync(output, { recursive: true });
  await openOrganize(page, output);
  await stubNoSuggestions(page);
  await fillMangaInfo(page, FORM_TITLE);
  await addLibraryFolder(page);
  await expect(
    page.locator('[data-testid="plan-row"][data-kind="book"]'),
    "解析した本が一覧に出ていない",
  ).toHaveCount(BOOK_COUNT, { timeout: 60_000 });
  return output;
}

/**
 * 本の行。元になったアーカイブで引く。
 *
 * 出来上がる名前で引くと、名前が変わったときに「行が無い」としか言えない。
 * 素材との対応は元パスで固定して、名前は属性として読む。
 */
function bookRow(page: Page, source: string): Locator {
  return page.locator(
    `[data-testid="plan-row"][data-kind="book"][data-source="${source}"]`,
  );
}

test.describe("整理済みの本の名前", () => {
  test("整理済みの本だけ、自分の名前のまま一覧に並ぶ", async ({ page }) => {
    // Arrange / Act
    await preparePlan(page, "自分の名前");

    // Assert - 前提。判定そのものは段階 1-3 で出来ている
    const organized = bookRow(page, library.organized);
    await expect(organized, "整理済みの本の行が無い").toHaveAttribute(
      "data-organized",
      "true",
    );

    // Assert - 整理済みの本は自分の名前。左の列の対では組み直さない。
    // 組み直すと、一覧には「作り直したら別人名義になる」という嘘が並ぶ
    await expect(
      organized,
      "整理済みの本が左の列の対で組み直されている",
    ).toHaveAttribute(
      "data-output-name",
      volumeName(SHELF_AUTHOR, SHELF_TITLE, SHELF_VOLUME),
    );

    // Assert - 対照。整理済みでない本は今までどおり左の列の対から。
    // 「常に元の名前を出す」実装はここで落ちる
    const plain = bookRow(page, library.plain);
    await expect(plain).toHaveAttribute("data-organized", "false");
    await expect(
      plain,
      "整理済みでない本まで自分の名前になっている",
    ).toHaveAttribute(
      "data-output-name",
      volumeName(FORM_AUTHOR, FORM_TITLE, PLAIN_VOLUME),
    );

    // Act - 左の列の作品名を変える。作品名を変えると著者は引き直されるので
    // 入れ直す
    await fillMangaInfo(page, LATER_TITLE);

    // Assert - 整理済みでない本の名前は往復なしで追従する。この原則は
    // 段階 4a でも変えない
    await expect(
      plain,
      "左の列を変えても一覧の名前が追従しない",
    ).toHaveAttribute(
      "data-output-name",
      volumeName(FORM_AUTHOR, LATER_TITLE, PLAIN_VOLUME),
    );

    // Assert - 整理済みの本の名前は動かない。上の 1 行を先に見てから
    // 確かめるのは、一覧がそもそも更新されない実装で「動かない」が
    // 満たされてしまうため
    await expect(
      organized,
      "整理済みの本の名前まで左の列に引きずられる",
    ).toHaveAttribute(
      "data-output-name",
      volumeName(SHELF_AUTHOR, SHELF_TITLE, SHELF_VOLUME),
    );
  });

  test("整理済みの本は、自分の作品フォルダへ作られる", async ({ page }) => {
    // Arrange
    const output = await preparePlan(page, "自分のフォルダ");

    // Arrange - 整理済みの本は既定で外れている（#73 段階 4b）。ここで見たいのは
    // 「作るとしたら、どの名前でどこへ置くか」なので、既定を前提にせず入れ直す。
    // 入れ直しても左の列ではなく自分の名前のまま作られる、が主張
    const organized = bookRow(page, library.organized).getByTestId(
      "plan-check",
    );
    if ((await organized.getAttribute("aria-checked")) !== "true")
      await organized.click();
    await expect(
      organized,
      "整理済みの本を入れた状態にできない",
    ).toHaveAttribute("aria-checked", "true");

    // Act
    await page.getByTestId("confirm").click();
    await expect(page.getByTestId("organize-status")).toContainText(
      "整理しました",
      { timeout: 60_000 },
    );

    // Assert - 置き場所まで見る。名前だけを見ると、名前を差し替えて
    // 置き場所は依頼の対のまま、という実装が通ってしまう。一覧が
    // 正しくても、投入に本ごとの名前が載っていなければここで落ちる
    expect(
      producedPaths(output),
      "整理済みの本が自分の作品フォルダへ作られていない",
    ).toEqual(
      [
        `${seriesDir(SHELF_AUTHOR, SHELF_TITLE)}/` +
          volumeName(SHELF_AUTHOR, SHELF_TITLE, SHELF_VOLUME),
        `${seriesDir(FORM_AUTHOR, FORM_TITLE)}/` +
          volumeName(FORM_AUTHOR, FORM_TITLE, PLAIN_VOLUME),
      ].sort(),
    );
  });
});
