import { expect, test, type Page } from "@playwright/test";
import { pageEntriesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * ページ分割の、1 枚ずつの操作（#58 段階 3）。
 *
 * 格子には同じ形の操作がページの数だけ並ぶ。どれも同じに見えるので、
 * 「いま触っているのがどのページか」は番号でしか区別できない。ここで
 * 確かめるのは 2 つ。
 *
 * 1. 拡大表示のまま前後の見開きへ移るとき、移る先が本の並び順に沿っている
 *    こと。どのカードからでも拡大表示は開くので、見開きでない行から
 *    始めることがある。そこから → を押して本の先頭側へ飛ぶと、利用者は
 *    「進んだのに戻った」画面を見せられ、どこまで見たかを見失う
 * 2. 同じ名前の操作が並ばないこと。読み上げの操作一覧では、名前が全部
 *    「2 ページに分ける」だと、どれがどのページのものか永久に分からない。
 *    **ただし名前にファイル名は使えない。** この画面は、割る前の 1 枚と
 *    割った半分の区別を利用者に見せない約束でできている
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 見開き 2 枚の寸法。幅を変えて、どちらを見ているかを絵の側からも読める */
const WIDE_SPREAD = [2400, 1800];
const NARROW_SPREAD = [2000, 1500];

/** 中央の既定位置。走査が位置を持たない行は floor(width / 2) から始まる */
const WIDE_CENTER = WIDE_SPREAD[0] / 2;
const NARROW_CENTER = NARROW_SPREAD[0] / 2;

/** 番号の区切り。見取り図と同じ EN DASH（U+2013） */
const RANGE = "–";

const ARCHIVE_SETUP = `
import io, json, sys, zipfile
from pathlib import Path
from PIL import Image

def flat(width, height, colour):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, "PNG")
    return buffer.getvalue()

def bicolour(width, height, left, right):
    image = Image.new("RGB", (width, height), left)
    half = Image.new("RGB", (width - width // 2, height), right)
    image.paste(half, (width // 2, 0))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()

def build(target, entries):
    with zipfile.ZipFile(Path(target), "w", zipfile.ZIP_DEFLATED) as archive:
        for index, entry in enumerate(entries, 1):
            name = "%03d.png" % index
            if entry["kind"] == "spread":
                data = bicolour(entry["w"], entry["h"], "#ff2020", "#2020ff")
            else:
                data = flat(entry["w"], entry["h"], entry["colour"])
            archive.writestr(name, data)
`;

const tall = (colour: string) => ({ kind: "flat", w: 1200, h: 1800, colour });

/**
 * 見開きを 2 枚、そのあいだに縦長を 1 枚はさんだ本。
 *
 * **はさむのが要点。** 見開きが後ろにしか無い本だと、「いちばん先頭の候補へ
 * 飛ぶ」実装でも → が前へ進んだように見えてしまう。前にも後ろにも候補が
 * ある行から動かして初めて、進んだのか戻ったのかを見分けられる。
 *
 * 2 枚の見開きで幅を変えてあるのは、開いている行を番号だけで確かめないため。
 * 番号の札を作り間違えている実装でも、幅（分割線の可動域）まで一致すれば
 * 見ている行を取り違えていない。
 */
function writeTwoSpreadArchive(name: string): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `${ARCHIVE_SETUP}
build(sys.argv[1], json.loads(sys.argv[2]))
`,
    target,
    JSON.stringify([
      tall("#00ff00"),
      { kind: "spread", w: WIDE_SPREAD[0], h: WIDE_SPREAD[1] },
      tall("#ffff00"),
      { kind: "spread", w: NARROW_SPREAD[0], h: NARROW_SPREAD[1] },
      tall("#00ffff"),
    ]),
  );
  return target;
}

function cardsOf(page: Page) {
  return page.locator('[data-testid="split-card"]');
}

function cardAt(page: Page, index: number) {
  return page.locator(`[data-testid="split-card"][data-index="${index}"]`);
}

/** ページ分割の画面を開き、走査が終わって格子が出るまで待つ */
async function openSplit(page: Page, archive: string, cards: number) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=split&archive=${encodeURIComponent(archive)}`,
  );
  await expect(page.getByTestId("split-grid")).toBeVisible({ timeout: 30_000 });
  await expect(cardsOf(page)).toHaveCount(cards, { timeout: 30_000 });
}

/** 画面に出ている番号を、並んでいる順に読む */
async function chipsOf(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="split-card"]')
    .evaluateAll((cards) =>
      cards.map(
        (card) =>
          card
            .querySelector<HTMLElement>('[data-testid="split-number"]')
            ?.textContent?.trim() ?? "",
      ),
    );
}

/** 拡大表示の見出し。開いているのがどの行かはここに出る */
function dialogTitle(page: Page) {
  return page.getByTestId("split-dialog").getByRole("heading");
}

/**
 * カードの絵を押して拡大表示を開く。
 *
 * 押す所を隅にするのは、真ん中には分割線が重なっていて掴んでしまうため
 * （split-reopen.spec.ts と同じ）。
 */
async function openDialogAt(page: Page, index: number) {
  await cardAt(page, index)
    .getByTestId("split-image")
    .click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId("split-dialog")).toBeVisible();
}

/**
 * 前後の見開きへ移る。
 *
 * 焦点はチェックへ明示的に置く。分割線に焦点があると ← → は位置の微調整に
 * なり（SplitLine が止める）、移動を押したつもりが何も起きない。どちらを
 * 試したのか分からない検証になる
 */
async function walk(page: Page, key: "ArrowLeft" | "ArrowRight") {
  await page.getByTestId("split-dialog-check").focus();
  await page.keyboard.press(key);
}

async function closeDialog(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("split-dialog")).toBeHidden();
}

test.describe("ページ分割: 拡大表示のまま前後へ移る", () => {
  test("見開きでない行からでも、→ は後ろへ ← は前へ移る", async ({ page }) => {
    // Arrange - 2 枚目と 4 枚目が見開き、3 枚目は縦長。番号は
    // 1 / 2–3 / 4 / 5–6 / 7 になる
    const archive = writeTwoSpreadArchive("前後の移動.zip");
    await openSplit(page, archive, 5);
    await page.getByTestId("split-all").click();
    expect(await chipsOf(page), "番号の並びが前提と違う").toEqual([
      "1",
      `2${RANGE}3`,
      "4",
      `5${RANGE}6`,
      "7",
    ]);

    // 制御 - 見開きどうしの移動は今までどおり動く。ここが動かない実装
    // （→ を効かなくする）でも下の検証は通ってしまうので、先に押さえる
    await openDialogAt(page, 1);
    await expect(dialogTitle(page)).toHaveText(`2${RANGE}3 ページ`);
    await walk(page, "ArrowRight");
    await expect(
      dialogTitle(page),
      "見開きから次の見開きへ移れていない",
    ).toHaveText(`5${RANGE}6 ページ`);
    // 幅の違う見開きなので、線の可動域まで入れ替わっている
    await expect(page.getByTestId("split-dialog-handle")).toHaveAttribute(
      "aria-valuenow",
      String(NARROW_CENTER),
    );
    await walk(page, "ArrowLeft");
    await expect(dialogTitle(page)).toHaveText(`2${RANGE}3 ページ`);
    await expect(page.getByTestId("split-dialog-handle")).toHaveAttribute(
      "aria-valuenow",
      String(WIDE_CENTER),
    );
    await closeDialog(page);

    // Act - 見開きでない 3 枚目（番号 4）から後ろへ移る
    await openDialogAt(page, 2);
    await expect(dialogTitle(page)).toHaveText("4 ページ");
    await walk(page, "ArrowRight");

    // Assert - 移る先は本の後ろにある見開き。ここで 2–3 が出るなら、
    // 利用者は「次へ」を押して本の前へ引き戻されている。読み返す順序が
    // 逆になり、どこまで見たかが分からなくなる
    await expect(
      dialogTitle(page),
      "→ で本の前の見開きへ戻ってしまっている",
    ).toHaveText(`5${RANGE}6 ページ`);
    await expect(page.getByTestId("split-dialog-handle")).toHaveAttribute(
      "aria-valuenow",
      String(NARROW_CENTER),
    );
    await closeDialog(page);

    // Act - 同じ行から前へ移る
    await openDialogAt(page, 2);
    await expect(dialogTitle(page)).toHaveText("4 ページ");
    await walk(page, "ArrowLeft");

    // Assert - 移る先は本の前にある見開き。何も起きない実装だと、
    // 利用者は拡大表示を閉じて自分で探し直すことになる
    await expect(dialogTitle(page), "← で前の見開きへ移れていない").toHaveText(
      `2${RANGE}3 ページ`,
    );
    await expect(page.getByTestId("split-dialog-handle")).toHaveAttribute(
      "aria-valuenow",
      String(WIDE_CENTER),
    );
  });
});

/**
 * 番号の札そのものを、名前の中の語として探すための形。
 *
 * 「1」を素朴に含むかどうかで見ると、「2–3」や「10」の一部にも当たる。
 * 数字と区切りに挟まれていないことまで見て、その札の番号だと言い切る。
 */
function labelPattern(label: string): RegExp {
  return new RegExp(`(?<![0-9${RANGE}])${label}(?![0-9${RANGE}])`);
}

/** 正規表現に埋めるための逃がし。ページ名には "." が入る */
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * いま ZIP に並んでいるページ名（と拡張子を落とした幹）のどれか。
 *
 * 幹まで見るのは、拡張子を落として出す実装が同じ漏れ方をするため。
 * 名前を書き写さず実物から作るので、ページ名の付け方が変わっても効く。
 */
function filenamePattern(entries: string[]): RegExp {
  const stems = entries.map((name) => name.replace(/\.[^.]+$/, ""));
  return new RegExp([...entries, ...stems].map(escapeForPattern).join("|"));
}

test.describe("ページ分割: 操作の読み上げ名", () => {
  test("チェックと拡大は、どのページのものかが読み上げ名で分かる", async ({
    page,
  }) => {
    // Arrange - 分割の提案をすべて採用する
    const archive = writeTwoSpreadArchive("読み上げ名.zip");
    await openSplit(page, archive, 5);
    await page.getByTestId("split-all").click();
    const chips = await chipsOf(page);

    // 制御 - 番号が互いに紛れない並びであること。どれかが他の一部に
    // なっていると、以降の「1 つだけ」が数え方の都合で崩れる
    expect(chips).toEqual(["1", `2${RANGE}3`, "4", `5${RANGE}6`, "7"]);

    const grid = page.getByTestId("split-grid");
    await expect(grid.getByRole("checkbox")).toHaveCount(5);
    await expect(grid.getByRole("button")).toHaveCount(5);

    // Assert - どの番号についても、その番号を名乗る操作は 1 つだけで、
    // それがそのページのカードの中にある。
    //
    // 「名前が互いに違う」だけを見ると、通し番号を後ろに付けただけの
    // 実装（2 ページに分ける (2)）でも通る。それは並び順の番号であって
    // ページ番号ではないので、割る・戻すで番号がずれた瞬間に嘘になる。
    // 札に出ている番号そのものを名乗ることまで見る
    for (const [index, label] of chips.entries()) {
      const pattern = labelPattern(label);
      const card = cardAt(page, index);

      await expect(
        grid.getByRole("checkbox", { name: pattern }),
        `${label} ページのチェックを、読み上げの一覧で選び出せない`,
      ).toHaveCount(1);
      await expect(card.getByTestId("split-check")).toHaveAccessibleName(
        pattern,
      );

      await expect(
        grid.getByRole("button", { name: pattern }),
        `${label} ページの拡大を、読み上げの一覧で選び出せない`,
      ).toHaveCount(1);
      await expect(card.getByTestId("split-zoom")).toHaveAccessibleName(
        pattern,
      );
    }

    // Assert - 名乗るのは番号であって、ファイル名ではない。名前で見分けさせると、
    // 「割る前の 1 枚」と「割った半分」の区別が読み上げに現れてしまう。
    // この画面はその区別を利用者に見せない約束でできている
    const entries = pageEntriesOf(archive);
    expect(entries, "検証に使うページ名が取れていない").toHaveLength(5);
    const filename = filenamePattern(entries);
    for (let index = 0; index < chips.length; index += 1) {
      const card = cardAt(page, index);
      await expect(
        card.getByTestId("split-check"),
        "チェックの読み上げ名がファイル名を名乗っている",
      ).not.toHaveAccessibleName(filename);
      await expect(
        card.getByTestId("split-zoom"),
        "拡大の読み上げ名がファイル名を名乗っている",
      ).not.toHaveAccessibleName(filename);
    }
  });
});
