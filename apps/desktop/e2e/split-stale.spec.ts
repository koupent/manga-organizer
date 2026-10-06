import { expect, test, type Page } from "@playwright/test";
import { coloursOf, pageEntriesOf, runPython } from "./archive";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * 分割で本が変わった後の、ページ並べ替えの画面（#58 段階 3）。
 *
 * ページ分割が確定すると、ページ数もページ名も変わる。同じ本を抱えている
 * ページ並べ替えは、その瞬間に別の本のカードを並べていることになる。
 *
 * 古いまま残ると、利用者は「割ったはずのページが出てこない」画面で並べ替え、
 * 保存を押す。送られるのはもう存在しない名前なので、書き込みは断られるか、
 * 通ってしまえば別のページを指した並びが書かれる。どちらにしても、割る作業と
 * 並べ替えの作業を続けて行うという普通の使い方が成り立たない。
 *
 * 数だけを見ても足りない。カードの枚数が合っていても、抱えている名前が
 * 古ければ保存は失敗する。**名前まで読み直したことは、その画面からの保存が
 * 通ることでしか確かめられない。**
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 見開きの寸法。比 1.333 で閾値（1.2）の上 */
const SPREAD = [2400, 1800];

/** 割る前・割った後のページ数。1 枚だけ割るので 1 つ増える */
const BEFORE_PAGES = 5;
const AFTER_PAGES = 6;

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

/** 縦長 1 枚ぶんの指定 */
const tall = (colour: string) => ({ kind: "flat", w: 1200, h: 1800, colour });

/**
 * 2 枚目だけが見開きの本。割ると 5 ページが 6 ページになる。
 *
 * ページごとに色を変えるのは、並べ替えが「どのページを」動かしたかを
 * 中身で追えるようにするため。名前は書き直しのたびに振り直されるので、
 * 名前だけでは何が動いたか分からない。
 */
function writeSpreadArchive(name: string): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `${ARCHIVE_SETUP}
build(sys.argv[1], json.loads(sys.argv[2]))
`,
    target,
    JSON.stringify([
      tall("#00ff00"),
      { kind: "spread", w: SPREAD[0], h: SPREAD[1] },
      tall("#ffff00"),
      tall("#ff00ff"),
      tall("#00ffff"),
    ]),
  );
  return target;
}

/** ページ並べ替えを対象付きで開く */
async function openReorder(page: Page, archive: string) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=reorder&archive=${encodeURIComponent(archive)}`,
  );
  await expect(page.getByTestId("mode-edit")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

/** いま並んでいるカードの名前を、並んでいる順に読む */
async function cardNames(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="editable-page"]')
    .evaluateAll((cards) =>
      cards.map((card) => (card as HTMLElement).dataset.name ?? ""),
    );
}

/**
 * カードを掴んで別のカードの位置まで運ぶ。
 *
 * dnd-kit はドラッグ終了から 50ms のあいだ click を document で止める。
 * 人はその間に押せないので、運び終えたら実際の操作と同じだけ間を空ける。
 */
async function dragCard(page: Page, from: number, to: number) {
  const cards = page.getByTestId("editable-page");
  await cards.nth(from).getByTestId("page-drag-handle").hover();
  await page.mouse.down();
  const box = (await cards.nth(to).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(100);
}

test.describe("ページ分割の確定と、ページ並べ替えの画面", () => {
  test("分割した後にページ並べ替えへ移ると、新しいページで並べて保存できる", async ({
    page,
  }) => {
    // Arrange - まずページ並べ替えを開く。ここで格子は割る前の 5 枚を抱える。
    // 先に開いておかないと、後から作られる格子は最初から新しい一覧で組まれ、
    // 「古いまま残る」かどうかを確かめたことにならない
    const archive = writeSpreadArchive("分割してから並べ替え.zip");
    await openReorder(page, archive);
    await expect(page.getByTestId("editable-page")).toHaveCount(BEFORE_PAGES);

    // Act - ページ分割へ移り、見開きを 1 枚割る
    await page.getByTestId("split-step-split").click();
    await expect(page.getByTestId("split-grid")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="split-card"]')).toHaveCount(
      BEFORE_PAGES,
      { timeout: 30_000 },
    );
    await page.getByTestId("split-all").click();
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toHaveAttribute(
      "data-state",
      "done",
      { timeout: 30_000 },
    );

    // 制御 - 本は実際に 1 ページ増えている。増えていなければ、以降は
    // 「何も変わっていない本」を見ているだけになる
    const entries = pageEntriesOf(archive);
    expect(entries, "分割が本を書き換えていない").toHaveLength(AFTER_PAGES);

    // Act - ページ並べ替えへ戻る
    await page.getByTestId("split-step-merge").click();

    // Assert - 枚数が新しいページ数になっている。ここを先に見るのは、
    // 1 枚も描かれていない格子で名前の検証が空回りしないようにするため
    await expect(
      page.getByTestId("editable-page"),
      "割ってページが増えたのに、古い枚数のまま並んでいる",
    ).toHaveCount(AFTER_PAGES);

    // Assert - 並んでいるのは、いま ZIP にある名前そのもの。枚数だけでは
    // 「たまたま数が合っただけ」を見分けられない
    expect(
      await cardNames(page),
      "カードが抱えている名前が、いまのページ一覧と違う",
    ).toEqual(entries);

    // Act - その画面で並べ替えて保存する。名前まで読み直したかどうかは、
    // 保存が通るかどうかにしか現れない
    await dragCard(page, 0, 2);
    await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");
    await page.getByTestId("split-confirm").click();
    await expect(
      page.getByTestId("split-status"),
      "古い名前で保存しようとして断られている",
    ).toContainText("変更を反映しました", {
      timeout: 30_000,
    });

    // Assert - 書かれた中身が、画面で運んだとおりになっている。
    // 「保存しました」の文だけを見ると、何も書かれていなくても通る。
    // 割った 2 枚（右半分＝青が先、左半分＝赤が次）が先頭へ繰り上がり、
    // 1 枚目だった緑がその後ろへ回る
    const painted = coloursOf(archive);
    expect(
      pageEntriesOf(archive).map((name) => painted[name]),
      "保存した並びが本に入っていない",
    ).toEqual([
      "#2020ff",
      "#ff2020",
      "#00ff00",
      "#ffff00",
      "#ff00ff",
      "#00ffff",
    ]);
  });

  test("並べ替えを保存したら、その並びが次の基準になる", async ({ page }) => {
    // Arrange - 3 ページ。色でどのページか見分ける
    const archive = writeArchive(sidecar.workDir, "保存後の基準.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
      { name: "003.jpg", color: "#0000ff" },
    ]);
    // JPEG は書き直しで色が 1 ずつ動く。絶対値ではなく、書き換える前の
    // 中身と突き合わせて「どのページが来たか」を見る
    const before = coloursOf(archive);
    await openReorder(page, archive);
    await expect(page.getByTestId("editable-page")).toHaveCount(3);

    // Act - 1 枚目を 3 枚目の位置へ運んで保存する
    await dragCard(page, 0, 2);
    await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toContainText(
      "変更を反映しました",
      { timeout: 30_000 },
    );

    // 制御 - 本は実際に書き換わっている。書き換わっていなければ、以降の
    // 検証は「保存が効かなかっただけ」の画面を見ていることになる
    const after = coloursOf(archive);
    expect(after["001.jpg"], "保存が本へ届いていない").toBe(before["002.jpg"]);
    expect(after["002.jpg"]).toBe(before["003.jpg"]);
    expect(after["003.jpg"]).toBe(before["001.jpg"]);

    // Assert - 保存が通った並びは、もう「未保存の変更」ではない。
    // 出たままだと、利用者は保存が効いていないと思ってもう一度押す
    await expect(
      page.getByTestId("split-confirm"),
      "保存が通ったのに未保存の印が消えない",
    ).toHaveText("確認済みにする");
    await expect(page.getByTestId("split-confirm")).toBeEnabled();

    // Assert - 書き込みで連番は振り直される。画面が抱える名前もその新しい
    // 連番でなければならない。ここが古いままだと、次に保存したとき
    // 「002.jpg」がもう別の絵を指していて、利用者が並べた覚えのない順序が
    // 書き込まれる
    expect(
      await cardNames(page),
      "保存した後もカードが古い名前を抱えている",
    ).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
  });
});
