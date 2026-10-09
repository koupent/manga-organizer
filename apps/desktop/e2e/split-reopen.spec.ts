import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  derivedRecordsOf,
  pageEntriesOf,
  pageSizesOf,
  runPython,
  storedOriginalsOf,
} from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 割った本を開き直したときの画面（#58 段階 3）。
 *
 * 一度割ると、ZIP に残るのは 2 枚の縦長ページになる。それでも画面は
 * 1 枚の見開きとして出し、線を動かす・割る前へ戻すができなければならない。
 *
 * この機能でいちばん大事なのがここ。利用者は「元画像」も「割った半分」も
 * 知らないし、知りたくないと言っている。開き直したときに 2 枚のページが
 * 見えたら、その約束はその場で破れる。割ったばかりの状態（同じ窓）と
 * 開き直した状態が同じ画面になることを、まっさらな窓で確かめる。
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 割る前の見開きの寸法 */
const SPREAD = [2400, 1800];

/**
 * 保存されている割る位置。中央（1200）から外す。
 *
 * 中央のままだと、記録を読まずに真ん中へ線を置く実装でも同じ絵になる。
 * ずらしてあれば、線がどこに出るかで読んでいるかどうかが分かる。
 */
const STORED_X = 1300;

/** 番号の区切り。見取り図と同じ EN DASH（U+2013） */

/**
 * 3 枚目が見開きの本を作り、段階 1 のコアでその見開きを STORED_X で割る。
 *
 * 画面ではなくコアで割るのは、開き直しの検証が「画面が書いたもの」に
 * 依存しないようにするため。画面が間違った位置で書いていても、それを
 * そのまま読み返して辻褄が合ってしまう。
 */
function writeSplitArchive(name: string): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `
import io, sys, zipfile
from pathlib import Path
from PIL import Image
from manga_core.page_splitter import SplitIntent, SplitPosition, apply_rows, scan_rows

def flat(width, height, colour):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, "PNG")
    return buffer.getvalue()

spread = Image.new("RGB", (2400, 1800), "#ff2020")
spread.paste(Image.new("RGB", (1200, 1800), "#2020ff"), (1200, 0))
buffer = io.BytesIO()
spread.save(buffer, "PNG")

target = Path(sys.argv[1])
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("001.png", flat(1200, 1800, "#00ff00"))
    archive.writestr("002.png", flat(1200, 1800, "#ffff00"))
    archive.writestr("003.png", buffer.getvalue())
    archive.writestr("004.png", flat(1200, 1800, "#00ffff"))

rows = list(scan_rows(target))
apply_rows(
    target,
    [
        SplitIntent(
            names=row.names,
            split=SplitPosition(x=int(sys.argv[2])) if row.is_spread else None,
        )
        for row in rows
    ],
)
`,
    target,
    String(STORED_X),
  );
  return target;
}

/**
 * まっさらな窓で開き直す。
 *
 * 同じ窓を使い回すと、格子には確定する前の行がそのまま残っている。
 * 「1 枚の見開きに見える」は最初から成り立っていて、読み直しについては
 * 何も確かめていないことになる。窓を分ければ、いま ZIP と同梱の記録から
 * 組み直した行だけを見ることになる。
 */
async function reopen(
  browser: Browser,
  archive: string,
  cards: number,
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=split&archive=${encodeURIComponent(archive)}`,
  );
  await expect(page.getByTestId("split-grid")).toBeVisible({ timeout: 30_000 });
  // 割り終えた本は②「見開きにする」から開く。分割の線を触るので①へ移る（#153）
  await showSplitStep(page);
  await expect(page.locator('[data-testid="split-card"]')).toHaveCount(cards, {
    timeout: 30_000,
  });
  return page;
}

/** ①「単ページにする」へ移る。保存していない変更は無い前提 */
async function showSplitStep(page: Page) {
  await page.getByTestId("split-step-split").click();
  await expect(page.getByTestId("split-step-split")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

function cardAt(page: Page, index: number) {
  return page
    .locator(`[data-testid="split-card"][data-index="${index}"]`)
    .first();
}

async function boxOf(page: Page, locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("要素が描画されていません");
  return box;
}

/** 画像の幅に対する、線の位置の割合。窓の大きさに左右されずに比べられる */
async function splitFraction(page: Page): Promise<number> {
  const image = await boxOf(page, page.getByTestId("split-dialog-image"));
  const handle = await boxOf(page, page.getByTestId("split-dialog-handle"));
  return (handle.x + handle.width / 2 - image.x) / image.width;
}

/**
 * 名前を運びうる属性。読み上げ・吹き出し・画面のどれかに現れる。
 *
 * `src` と `srcset` は入れない。画像の URL には ``name=003.png`` が要る
 * （サイドカーがページを名前で引くため）が、これは画面にも読み上げにも
 * 現れない。ここに入れると、直しようのない失敗を出し続けることになる。
 * URL に名前が載っていることは、別途つぶすべき残りの経路として扱う。
 *
 * `class` と `style` も入れない。読み上げられないうえ、寸法の px 値が
 * 3 桁の連番とたまたま重なって、名前が漏れていないのに落ちる。
 */
const NAMED_ATTRIBUTES = [
  "alt",
  "title",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-valuetext",
  "placeholder",
  "value",
];

/**
 * カード 1 枚が持っている「読める文字」を全部集める。
 *
 * textContent だけを見ると、alt・title・aria-label・data-* から漏れた名前を
 * 見逃す。どれも読み上げか吹き出しで利用者に届くので、画面に書いてあるのと
 * 変わらない。data-* をまとめて拾うのは、そこへ名前を置いて CSS で
 * 出す実装（content: attr(data-name)）も同じ漏れ方をするため。
 */
async function readableStringsOf(card: Locator): Promise<string[]> {
  return card.evaluate((root, named) => {
    const found: string[] = [];
    for (const node of [root, ...root.querySelectorAll("*")]) {
      for (const attribute of Array.from(node.attributes)) {
        if (
          !named.includes(attribute.name) &&
          !attribute.name.startsWith("data-")
        ) {
          continue;
        }
        found.push(`${attribute.name}=${attribute.value}`);
      }
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType !== Node.TEXT_NODE) continue;
        const text = (child.nodeValue ?? "").trim();
        if (text) found.push(text);
      }
    }
    return found;
  }, NAMED_ATTRIBUTES);
}

/** いまの内容で確定し、書き込みが終わるまで待つ */
async function confirmSplit(page: Page) {
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-status")).toHaveAttribute(
    "data-state",
    "done",
    { timeout: 30_000 },
  );
}

test.describe("ページ分割: 割った本を開き直す", () => {
  test("割った対も共通のページ一覧に出て、拡大すると保存された位置の線を編集できる", async ({
    browser,
  }) => {
    // Arrange - 3 枚目の見開きを 1300 で割った本。ZIP には 5 枚並んでいる
    const archive = writeSplitArchive("開き直し.zip");
    const entries = pageEntriesOf(archive);
    expect(entries).toHaveLength(5);

    // Act - まっさらな窓で開く
    const page = await reopen(browser, archive, entries.length);

    await expect(page.locator('[data-testid="split-card"]')).toHaveCount(5);

    // 共通一覧には保存済みの単ページを出す。線の編集は元画像の拡大表示で行う
    const folded = await boxOf(page, cardAt(page, 2));
    const plain = await boxOf(page, cardAt(page, 0));
    expect(
      folded.width,
      `畳んだ行の幅が ${Math.round(folded.width)}px、縦長は ${Math.round(plain.width)}px`,
    ).toBeCloseTo(plain.width, 0);

    await page.getByTestId("editable-page").nth(2).getByTestId("zoom").click();

    // Assert - 線は保存された位置に出る。読み取りの値と、実際に描かれて
    // いる位置の両方を見る。片方だけだと、値は正しいのに絵の上では
    // 中央に描かれている実装を見逃す
    await expect(page.getByTestId("split-dialog-handle")).toHaveAttribute(
      "aria-valuenow",
      String(STORED_X),
    );
    const fraction = await splitFraction(page);
    expect(
      Math.abs(fraction - STORED_X / SPREAD[0]),
      `線が画像の ${fraction.toFixed(3)} の所にある（保存されているのは ${(STORED_X / SPREAD[0]).toFixed(3)}）`,
    ).toBeLessThan(0.015);
    expect(
      Math.abs(fraction - 0.5),
      "線が中央にある。記録を読まず既定の位置に置いているだけ",
    ).toBeGreaterThan(0.02);

    // Assert - 番号は畳んだ結果から数える。3 行目が 2 ページ分になる
    const chip = cardAt(page, 2).getByTestId("split-number");
    await page.getByTestId("split-dialog-close").click();
    await expect(chip).toHaveText("3");

    // Assert - 開いただけでは何も保留していない。青い（書き込む前と違う）
    // ままだと、利用者は毎回「何か変えてしまった」と思わされる
    await expect(chip).toHaveAttribute("data-pending", "false");
    await expect(page.getByTestId("split-status")).toHaveText(
      "変更はありません",
    );
    await expect(page.getByTestId("split-confirm")).toBeEnabled();

    await page.context().close();
  });

  /**
   * 見える文字だけでなく、読み上げと吹き出しまで見る。
   *
   * textContent しか見ない検証は、alt・title・aria-label・data-* へ名前を
   * 置いた実装を素通しする。どれも利用者に届く経路で、届いた時点でこの機能の
   * 約束（元画像と割った半分の区別を見せない）は破れている。
   */
  test("分割の作業面はページ番号で表示し、復元用の元画像名を出さない", async ({
    browser,
  }) => {
    // Arrange
    const archive = writeSplitArchive("名前を出さない.zip");
    const entries = pageEntriesOf(archive);
    const page = await reopen(browser, archive, entries.length);

    // Assert - 先にカードが並んでいることを確かめる。何も描かれていない
    // 画面でも「名前が出ていない」は成り立ってしまう
    await expect(page.locator('[data-testid="split-card"]')).toHaveCount(5);
    await expect(cardAt(page, 2).getByTestId("split-applied")).toHaveText(
      "分割済み",
    );

    // Assert - 畳んだ行の 2 つの名前も、畳まない行の 1 つの名前も出ない。
    // 畳んだ行だけを見る検証は、縦長ページに名前を出す実装でも通る。
    // その実装では「名前が 2 つある行」と「1 つの行」の違いが、名前が
    // 出ていないことそのもので分かってしまう
    // 共通カードのヘッダーには保存済みのファイル名を表示する。
    // 分割の作業面は引き続きページ番号だけで、復元用の名前を見せない。
    const text = (await page.getByTestId("split-card").allTextContents()).join(
      "",
    );
    for (const name of entries) {
      expect(text, `カードに ${name} が出ている`).not.toContain(name);
      // 拡張子を落として出す実装も同じ漏れ方をする。番号の札は "3–4" の
      // ような通し番号なので、"003" とは重ならない
      const stem = name.replace(/\.[^.]+$/, "");
      expect(text, `カードに ${stem} が出ている`).not.toContain(stem);
    }

    // Assert - 見える文字だけでは足りない。alt・title・aria-label・data-* に
    // 名前が入っていれば、読み上げにも吹き出しにも出る。利用者は
    // 「元画像」と「割った半分」があることを、そこで知ってしまう
    for (const [index, chip] of [
      [0, "1"],
      [2, "3"],
    ] as const) {
      const readable = await readableStringsOf(cardAt(page, index));

      // 制御 - 集められていることを先に確かめる。1 つも拾えていない
      // 集合なら「名前が入っていない」は何も確かめていない。番号の札は
      // 必ず読める所にあるので、それが取れていることを目印にする
      expect(
        readable,
        `${index} 番目のカードから読める文字を拾えていない`,
      ).toContain(chip);

      for (const value of readable) {
        for (const name of entries) {
          const stem = name.replace(/\.[^.]+$/, "");
          expect(
            value,
            `${index} 番目のカードの ${value} に ${name} が入っている`,
          ).not.toContain(name);
          expect(
            value,
            `${index} 番目のカードの ${value} に ${stem} が入っている`,
          ).not.toContain(stem);
        }
      }
    }

    await page.context().close();
  });

  test("線を動かして確定すると、割った 2 枚が置き換わる", async ({
    browser,
  }) => {
    // Arrange
    const archive = writeSplitArchive("位置を直す.zip");
    const page = await reopen(browser, archive, 5);

    // Act - 画像を押して拡大表示にし、線に焦点を当てて Shift+→ で 10px ずつ
    // 動かす。掴んで運ぶより、意図した値ぴったりに置ける。
    // 押す所を隅にするのは、真ん中には線が重なっていて掴んでしまうため
    await cardAt(page, 2)
      .getByTestId("split-image")
      .click({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId("split-dialog")).toBeVisible();
    const handle = page.getByTestId("split-dialog-handle");
    await handle.focus();
    for (let step = 0; step < 5; step += 1) {
      await page.keyboard.press("Shift+ArrowRight");
    }
    await expect(handle).toHaveAttribute(
      "aria-valuenow",
      String(STORED_X + 50),
    );

    // Assert - 重ね枠の中に確定はない。押す所が 2 つあると、どちらが
    // 書き込むのかが分からなくなる。主操作は画面に 1 つだけ置く
    await expect(
      page.getByTestId("split-dialog").getByTestId("split-confirm"),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("split-dialog")).toBeHidden();
    await expect(page.getByTestId("split-status")).toHaveText(
      "1 枚の分割位置を直します",
    );

    // Act
    await confirmSplit(page);

    // Assert - ページは増えも減りもしない。位置を直しただけ
    const entries = pageEntriesOf(archive);
    expect(entries).toHaveLength(5);

    // Assert - 2 枚が新しい位置で割り直されている。右綴じなので先が右半分
    const sizes = pageSizesOf(archive);
    expect(sizes[entries[2]]).toEqual([SPREAD[0] - (STORED_X + 50), SPREAD[1]]);
    expect(sizes[entries[3]]).toEqual([STORED_X + 50, SPREAD[1]]);

    // Assert - 割る前の画像は 1 枚のまま。動かすたびに増えるなら、割った
    // 半分を新しい元画像として貯め込んでいる。次に開いたときには、その
    // 半分が「割る前の 1 枚」として出る
    expect(storedOriginalsOf(archive).originals).toHaveLength(1);

    // Assert - 記録は新しい 2 枚のぶんだけ。寸法だけを見ると、前の半分から
    // さらに割った実装でも数が合う。古い記録が残っていれば、次に開いたとき
    // 対にできない半分が出てくる
    const derived = derivedRecordsOf(archive);
    expect(
      Object.keys(derived).sort(),
      "割った跡の記録が 2 件になっていない",
    ).toHaveLength(2);
    expect(
      Object.values(derived).map((record) => record.operations[0].params.x),
    ).toEqual([STORED_X + 50, STORED_X + 50]);

    await page.context().close();
  });

  test("保存済み加工の復元で、1 枚の横長ページに戻る", async ({ browser }) => {
    // Arrange
    const archive = writeSplitArchive("割る前へ戻す.zip");
    const page = await reopen(browser, archive, 5);

    await expect(cardAt(page, 2).getByTestId("split-check")).toBeDisabled();
    await page.getByTestId("editor-select-none").click();
    expect(pageEntriesOf(archive)).toHaveLength(5);
    await page
      .getByRole("combobox", { name: "保存済み編集の復元" })
      .selectOption("split");
    await page.getByTestId("edit-reset-confirm").click();
    await expect(page.getByTestId("edit-reset-dialog")).toBeHidden();

    // Assert - ページが 1 枚減った
    const entries = pageEntriesOf(archive);
    expect(entries).toHaveLength(4);
    expect(pageSizesOf(archive)[entries[2]]).toEqual(SPREAD);

    // Assert - 戻ったのは、貼り合わせた絵ではなく取ってあった元画像そのもの。
    // 貼り合わせでは、割った時の再圧縮のぶんだけ画質が落ちたものが残る
    expect(
      restoredMatchesOriginal(archive, entries[2]),
      "戻したページが、取ってあった割る前の画像と同じバイト列でない",
    ).toBeTruthy();

    // 復元は選択解除と独立しており、分割モードに留まる。
    await expect(page.getByTestId("split-page-count")).toHaveText("4 ページ");
    await showSplitStep(page);
    await expect(cardAt(page, 2)).toHaveAttribute("data-checked", "false");
    await expect(cardAt(page, 2).getByTestId("split-number")).toHaveAttribute(
      "data-pending",
      "false",
    );
    await expect(page.getByTestId("split-confirm")).toBeEnabled();

    // 開き直しても見開きのまま残り、分割対象として扱える。
    await page.reload();
    await showSplitStep(page);
    await page.getByTestId("editor-select-none").click();
    await expect(page.getByTestId("split-step-split")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator('[data-testid="split-card"]')).toHaveCount(4);
    await expect(cardAt(page, 2)).toHaveAttribute("data-checked", "false");
    await expect(cardAt(page, 2).getByTestId("split-kept-whole")).toBeVisible();
    await expect(cardAt(page, 2)).toHaveAttribute("data-target", "true");
    await expect(page.getByTestId("split-status")).toHaveText(
      "変更はありません",
    );

    await page.context().close();
  });
});

/**
 * 戻したページが、同梱されている割る前の画像とバイト単位で同じか。
 *
 * 寸法だけを見ると、割った半分を横に並べて作り直した絵でも通ってしまう。
 */
function restoredMatchesOriginal(archive: string, name: string): boolean {
  const output = runPython(
    `
import json, sys, zipfile
from manga_core.original_store import ORIGINALS_PREFIX
with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    originals = sorted(n for n in names if n.startswith(ORIGINALS_PREFIX))
    same = len(originals) == 1 and archive.read(originals[0]) == archive.read(
        sys.argv[2]
    )
print(json.dumps(same))
`,
    archive,
    name,
  );
  return JSON.parse(output);
}
