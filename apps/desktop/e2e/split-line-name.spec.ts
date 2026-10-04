import { expect, test, type Page } from "@playwright/test";
import { pageEntriesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 分割線の読み上げ名（#58 段階 3）。
 *
 * 格子には同じ形の操作がページの数だけ並ぶ。チェックと拡大には番号を名乗らせた
 * （split-card-controls.spec.ts）が、分割位置のつまみは「分割位置」のままで、
 * 読み上げの操作一覧に同じ名前がいくつも並ぶ。目で見て選べない利用者にとって、
 * それはどのページの位置を動かしているのか分からないまま線を動かすということで、
 * 気づかないうちに別のページを割ることになる。
 *
 * **名乗るのは番号であって、ファイル名ではない。** この画面は、割る前の 1 枚と
 * 割った半分の区別を利用者に見せない約束でできている（split-reopen.spec.ts が
 * カードの読める文字すべてについてこれを見張っている）。
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 見開き 2 枚の寸法。幅を変えて、どちらを見ているかを線の可動域からも読める */
const WIDE_SPREAD = [2400, 1800];
const NARROW_SPREAD = [2000, 1500];

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
 * 見開きが 2 枚要る。1 枚しか無い本では「名前が互いに違う」を確かめられず、
 * 全部を同じ名前で通す実装と見分けが付かない。
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
  await expect(page.locator('[data-testid="split-card"]')).toHaveCount(cards, {
    timeout: 30_000,
  });
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

/**
 * 番号の札そのものを、名前の中の語として探すための形
 * （split-card-controls.spec.ts と同じ）。
 *
 * 「1」を素朴に含むかどうかで見ると、「2–3」や「10」の一部にも当たる。
 */
function labelPattern(label: string): RegExp {
  return new RegExp(`(?<![0-9${RANGE}])${label}(?![0-9${RANGE}])`);
}

/** 正規表現に埋めるための逃がし。ページ名には "." が入る */
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** いま ZIP に並んでいるページ名（と拡張子を落とした幹）のどれか */
function filenamePattern(entries: string[]): RegExp {
  const stems = entries.map((name) => name.replace(/\.[^.]+$/, ""));
  return new RegExp([...entries, ...stems].map(escapeForPattern).join("|"));
}

test.describe("ページ分割: 分割線の読み上げ名", () => {
  test("分割位置のつまみは、どのページのものかが読み上げ名で分かる", async ({
    page,
  }) => {
    // Arrange - 2 枚目と 4 枚目が見開き。番号は 1 / 2–3 / 4 / 5–6 / 7 になる
    const archive = writeTwoSpreadArchive("線の読み上げ名.zip");
    await openSplit(page, archive, 5);
    await page.getByTestId("split-accept-all").click();
    const chips = await chipsOf(page);
    expect(chips, "番号の並びが前提と違う").toEqual([
      "1",
      `2${RANGE}3`,
      "4",
      `5${RANGE}6`,
      "7",
    ]);

    // 制御 - つまみは 2 つ出ている。1 つも無い（あるいは 1 つしか無い）画面では、
    // 「名前で選び分けられる」は何も確かめていない
    const grid = page.getByTestId("split-grid");
    await expect(
      grid.getByRole("slider"),
      "分割位置のつまみが 2 つ並んでいない",
    ).toHaveCount(2);

    // Assert - どちらのつまみも、自分のページの番号を名乗る。
    // 「名前が互いに違う」だけを見ると、通し番号を後ろに付けただけの実装
    // （分割位置 (2)）でも通る。それは並び順であってページ番号ではないので、
    // 割る・戻すで番号がずれた瞬間に嘘になる
    const spreads = [1, 3] as const;
    const names: string[] = [];
    for (const index of spreads) {
      const label = chips[index];
      const handle = cardAt(page, index).getByTestId("split-handle");
      await expect(handle, `${label} ページにつまみが無い`).toHaveCount(1);
      await expect(
        handle,
        `${label} ページのつまみが、その番号を名乗っていない`,
      ).toHaveAccessibleName(labelPattern(label));
      await expect(
        grid.getByRole("slider", { name: labelPattern(label) }),
        `${label} ページのつまみを、読み上げの一覧で選び出せない`,
      ).toHaveCount(1);
      names.push(
        (await handle.evaluate((node) => node.getAttribute("aria-label"))) ??
          "",
      );
    }

    // Assert - 2 つの名前は互いに違う。同じ名前が並ぶと、読み上げの一覧では
    // どちらを触っているのか永久に分からない
    expect(names[0], "2 つのつまみが同じ名前を名乗っている").not.toBe(names[1]);

    // Assert - 名乗るのは番号であって、ファイル名ではない。名前で見分けさせると、
    // 「割る前の 1 枚」と「割った半分」の区別が読み上げに現れてしまう
    const entries = pageEntriesOf(archive);
    expect(entries, "検証に使うページ名が取れていない").toHaveLength(5);
    const filename = filenamePattern(entries);
    for (const index of spreads) {
      await expect(
        cardAt(page, index).getByTestId("split-handle"),
        "つまみの読み上げ名がファイル名を名乗っている",
      ).not.toHaveAccessibleName(filename);
    }
  });
});
