import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { coloursOf, runPython } from "./archive";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * 並べ替えを保存した後の、ページ並べ替えの画面。
 *
 * 保存すると ZIP の連番は振り直される。**名前はほとんど据え置きのまま、
 * その名前が指す絵だけが入れ替わる。** 001.jpg は保存の前後どちらにも
 * 存在して、中身だけが別のページになる。
 *
 * ここで確かめるのは、その「名前は同じ・中身は別」を画面が取り違えないこと。
 *
 * 1. 保存が通ったら、カードに描かれている絵も新しいページのものになること。
 *    番号だけが新しく、絵が古いままなら、利用者は自分が並べた覚えのない
 *    見た目を渡され、直そうとしてもう一度並べ替える
 * 2. 保存の後の読み直しに失敗したときは、古い並びのまま押し直させないこと。
 *    書き込みは既に通っていて、画面が抱える名前は書き込む前のもの。そのまま
 *    もう一度保存すると、いま別の絵を指している名前を並べて送ることになる
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 保存が通ったときの文。読み直しの失敗と見分けるのに使う */
const SAVED_MESSAGE = "変更を反映しました";

/** 見張る長さ（ms）と間隔。押せる窓が一瞬でも開けば当たる細かさ */
const WATCH_MS = 1_500;
const SAMPLE_INTERVAL_MS = 25;

/**
 * カードに実際に描かれている絵の色を読む。
 *
 * 名前も番号も見ない。この節で捕まえたい取り違えは、名前が正しいまま絵だけが
 * 古いというものなので、名前や枚数をいくら見ても現れない。描かれた画素を
 * そのまま見るしかない。
 *
 * 画像はサイドカー（別のオリジン）から来るので、canvas へ写して読むことは
 * できない（汚染される）。cover.spec.ts が見え方の指紋に使っているのと同じ
 * ように要素の写しを撮り、色の判定は archive.ts と同じく Pillow に任せる。
 */
const PROBE_SCRIPT = `
import json, sys
from PIL import Image

NAMES = ("赤", "緑", "青")

def painted(path):
    with Image.open(path) as opened:
        image = opened.convert("RGB")
        # 絵の中央には白いページ名が乗っている。平らな左上だけを見る
        left, top = int(image.width * 0.08), int(image.height * 0.08)
        patch = image.crop(
            (left, top, max(int(image.width * 0.30), left + 1), max(int(image.height * 0.30), top + 1))
        )
        pixels = list(patch.getdata())
    channels = [sum(pixel[i] for pixel in pixels) / len(pixels) for i in range(3)]
    ranked = sorted(zip(channels, NAMES), reverse=True)
    # 抜きん出た色が無ければ読み取れていない。色の名前を騙らず、値をそのまま返す。
    # 「たまたま期待と違う色に見えた」と「そもそも読めていない」を混ぜない
    if ranked[0][0] - ranked[1][0] < 40:
        return "不明(%d,%d,%d)" % tuple(channels)
    return ranked[0][1]

print(json.dumps([painted(path) for path in sys.argv[1:]]))
`;

let probeSequence = 0;

/** 並んでいるカードに描かれている色を、並んでいる順に読む */
async function paintedColoursOf(page: Page): Promise<string[]> {
  const cards = page.locator('[data-testid="editable-page"]');
  const total = await cards.count();
  const shots: string[] = [];
  for (let index = 0; index < total; index += 1) {
    probeSequence += 1;
    const file = join(sidecar.workDir, `probe-${probeSequence}.png`);
    writeFileSync(file, await cards.nth(index).locator("img").screenshot());
    shots.push(file);
  }
  return JSON.parse(runPython(PROBE_SCRIPT, ...shots));
}

/**
 * 描かれている色が期待どおりになるまで待つ。
 *
 * 待つのは、絵を取り直す作りなら読み込みの往復ぶんだけ遅れて変わるため。
 * 一度読んで決め付けると、正しい実装を「まだ届いていない」瞬間で落とす。
 */
async function expectPainted(page: Page, expected: string[], message: string) {
  // 読み直し中は画像要素の表示も入れ替わるので、撮影から再試行する。
  await expect(async () => {
    expect(await paintedColoursOf(page), message).toEqual(expected);
  }).toPass({ timeout: 20_000 });
}

/** ページ並べ替えを対象付きで開く */
async function openReorder(page: Page, archive: string) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=reorder&archive=${encodeURIComponent(archive)}`,
  );
  await page.getByTestId("split-step-merge").click();
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

/**
 * 保存が押せるかどうかを、一定の間隔で控え続ける。
 *
 * ある瞬間に押せないことを 1 回見るだけでは足りない。読み直しが失敗した後
 * ずっと押せないことを言うには、その窓の全体を見張るしかない
 * （split-inflight.spec.ts と同じ作り）。
 *
 * 押す所ごと消す作りもありうるので、無い場合は「押せない」として数える。
 */
async function watchSave(page: Page, duration: number): Promise<boolean[]> {
  return page.evaluate(
    async ({ span, interval }) => {
      const samples: boolean[] = [];
      const started = performance.now();
      while (performance.now() - started < span) {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-testid="split-confirm"]',
        );
        samples.push(button !== null && !button.disabled);
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
      return samples;
    },
    { span: duration, interval: SAMPLE_INTERVAL_MS },
  );
}

/** いま保存を押せるか。押せない状態で force クリックしても何も起きない */
async function saveIsPressable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="split-confirm"]',
    );
    return button !== null && !button.disabled;
  });
}

/** 画面が利用者に告げている文。状態欄と警告のどちらに出しても拾う */
async function announcedText(page: Page): Promise<string> {
  return page.evaluate(() =>
    ['[data-testid="split-status"]', '[data-testid="error"]']
      .map(
        (selector) =>
          document.querySelector(selector)?.textContent?.trim() ?? "",
      )
      .join(" "),
  );
}

/** 送られた POST の経路だけを控える */
function recordPosts(page: Page): string[] {
  const posted: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    posted.push(new URL(request.url()).pathname);
  });
  return posted;
}

test.describe("ページ並べ替え: 保存した後の見え方", () => {
  test("保存が通ったら、カードの絵も新しいページのものになる", async ({
    page,
  }) => {
    // Arrange - 3 ページ。中身の色でどのページかを見分ける
    const archive = writeArchive(sidecar.workDir, "保存後の絵.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
      { name: "003.jpg", color: "#0000ff" },
    ]);
    const before = coloursOf(archive);
    await openReorder(page, archive);
    await expect(page.getByTestId("editable-page")).toHaveCount(3);

    // 制御 - 開いた直後の絵が読めている。ここが読めないなら、以降の
    // 「絵が変わっていない」は色を読めていないだけでも成り立ってしまう
    await expectPainted(
      page,
      ["赤", "緑", "青"],
      "開いた直後のカードの絵を読めていない",
    );

    // Act - 1 枚目を 3 枚目の位置へ運んで保存する
    await dragCard(page, 0, 2);
    await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toContainText(
      SAVED_MESSAGE,
      {
        timeout: 30_000,
      },
    );
    await expect(page.getByTestId("split-confirm")).toHaveText(
      "確認済みにする",
    );

    // 制御 - 本の側では、同じ名前が別の絵を指すようになっている。
    // 名前ごと変わる並べ替えや、中身が動かない並べ替えを選んでしまうと、
    // 捕まえたい取り違えがそもそも起きない
    const after = coloursOf(archive);
    expect(
      Object.keys(after),
      "ページ名が振り直されておらず、名前の使い回しが起きていない",
    ).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
    expect(after["001.jpg"], "保存が本へ届いていない").toBe(before["002.jpg"]);
    expect(after["002.jpg"]).toBe(before["003.jpg"]);
    expect(after["003.jpg"]).toBe(before["001.jpg"]);
    expect(
      await cardNames(page),
      "カードが抱えている名前が、いまのページ一覧と違う",
    ).toEqual(["001.jpg", "002.jpg", "003.jpg"]);

    // Assert - 名前も番号も正しいのに、絵だけが古いということが起きてはならない。
    // 起きると、利用者は新しい番号の下に並べる前の絵を見せられ、直したはずの
    // 順序がまた崩れているように見える。もう一度並べ替えて保存すれば、今度は
    // 本当に崩れる
    await expectPainted(
      page,
      ["緑", "青", "赤"],
      "保存が通ったのに、カードには並べ替える前の絵が描かれたまま",
    );
  });

  test("別の画面が本を書き換えて作り直されても、カードの絵は新しいページのもの", async ({
    page,
  }) => {
    // Arrange - 並べ替えを開き、1 度保存しておく。保存すると絵の URL の世代が
    // 進み、その世代の URL で保存後の絵がブラウザに覚えられる
    const archive = writeArchive(sidecar.workDir, "作り直し後の絵.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
      { name: "003.jpg", color: "#0000ff" },
    ]);
    await openReorder(page, archive);
    await expectPainted(
      page,
      ["赤", "緑", "青"],
      "開いた直後の絵を読めていない",
    );
    await dragCard(page, 0, 2);
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toContainText(
      SAVED_MESSAGE,
      {
        timeout: 30_000,
      },
    );
    await expectPainted(
      page,
      ["緑", "青", "赤"],
      "保存した後の絵を読めていない",
    );

    // Act - サムネイル作成で 3 枚目（赤）を表紙にする。先頭へ移すので連番が
    // 振り直され、同じ名前が別の絵を指すようになる
    await page.getByTestId("mode-edit").click();
    const card = page.getByTestId("editable-page").filter({
      has: page.getByRole("group", { name: "003.jpg", exact: true }),
    });
    await card.getByRole("button", { name: /の操作/ }).click();
    await card
      .getByRole("menuitem", { name: "サムネイルにする", exact: true })
      .click();
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toHaveAttribute(
      "data-state",
      "done",
    );
    await expect(page.getByTestId("split-confirm")).toBeDisabled();

    // Assert - 並べ替えの画面は作り直される。世代を数え直して作り直す前と
    // 同じ URL になると、ブラウザが覚えている保存後の古い絵が出る
    await expectPainted(
      page,
      ["赤", "緑", "青"],
      "作り直されたのに、カードには書き換える前の絵が描かれたまま",
    );
  });

  test("保存の後の読み直しに失敗したら、古い並びで押し直させない", async ({
    page,
  }) => {
    // Arrange - 3 ページ。読み直しだけを落とすので、書き込みは本物のまま通る
    const archive = writeArchive(sidecar.workDir, "読み直しに失敗.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
      { name: "003.jpg", color: "#0000ff" },
    ]);
    const before = coloursOf(archive);
    const posted = recordPosts(page);

    // Arrange - 落とすのは「書き込みが通った後の」一覧の読み直しだけ。
    // 開いたときの読み込みまで落とすと、格子が出ないまま何も確かめられない
    let armed = false;
    let blocked = 0;
    await page.route(/\/api\/jobs\/split-scan/, async (route: Route) => {
      if (!armed) {
        await route.continue();
        return;
      }
      blocked += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "ページ一覧を読めませんでした（検証）",
        }),
      });
    });
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      if (new URL(request.url()).pathname.endsWith("/api/jobs/split")) {
        armed = true;
      }
    });

    await openReorder(page, archive);
    await expect(page.getByTestId("editable-page")).toHaveCount(3);

    // Act - 1 枚目を 3 枚目の位置へ運ぶ
    await dragCard(page, 0, 2);
    await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");

    // 制御 - 見張りが「押せる」を観測できている。ここが取れないと、後の
    // 「一度も押せなかった」は見張りが壊れているだけでも成り立つ
    expect(
      (await watchSave(page, 300)).some(Boolean),
      "押す前から保存が押せない。見張りとして成立しない",
    ).toBe(true);

    // Act - 保存する。書き込みは通り、その後の読み直しだけが落ちる
    await page.getByTestId("split-confirm").click();
    await expect
      .poll(() => blocked, {
        message: "保存の後の読み直しを落とせていない",
        timeout: 30_000,
      })
      .toBe(1);

    // 制御 - 書き込みは本当に通っている。通っていなければ、これは
    // 「保存が失敗しただけ」の画面で、古い名前は古いままで正しい
    const written = coloursOf(archive);
    expect(written["001.jpg"], "書き込みが本へ届いていない").toBe(
      before["002.jpg"],
    );
    expect(written["002.jpg"]).toBe(before["003.jpg"]);
    expect(written["003.jpg"]).toBe(before["001.jpg"]);

    // Assert - 失敗は黙って起きない。何が起きたのか分からないまま画面だけが
    // 変わると、利用者は保存が効かなかったと思って押し直す
    const announced = await announcedText(page);
    expect(
      announced.replace(SAVED_MESSAGE, "").replace(/\s/g, ""),
      "読み直しに失敗したことが画面のどこにも出ていない",
    ).not.toBe("");

    // Assert - 押せる状態に戻さない。抱えている名前は書き込む前のもので、
    // その名前はもう別の絵を指している。ここで押せると、利用者が並べた
    // 覚えのない順序がそのまま本へ書かれる
    const samples = await watchSave(page, WATCH_MS);
    expect(
      samples.length,
      `読み直しが失敗した後の窓を ${samples.length} 回しか観測できていない`,
    ).toBeGreaterThan(40);
    expect(
      samples.filter(Boolean).length,
      "読み直しに失敗した後、書き込む前の並びのまま保存を押せる",
    ).toBe(0);

    // Assert - 利用者と同じように押しても、2 度目は投入されない。
    // 「失敗を出したうえで押させる」実装を、文の検証だけで通さない
    if (await saveIsPressable(page)) {
      await page.getByTestId("split-confirm").click({ force: true });
    }
    await page.waitForTimeout(1_000);
    expect(
      posted.filter((path) => path.endsWith("/api/jobs/split")),
      "書き込む前の並びで 2 度目の保存が投入されている",
    ).toHaveLength(1);
    expect(coloursOf(archive), "2 度目の書き込みが本へ届いている").toEqual(
      written,
    );
  });
});
