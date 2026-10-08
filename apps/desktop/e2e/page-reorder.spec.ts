import { readFileSync, statSync, utimesSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { coloursOf, pageEntriesOf } from "./archive";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => {
  sidecar?.stop();
});

test.describe("ページ並べ替え", () => {
  test("サムネイルが並び、ドラッグで入れ替えて ZIP に保存できる", async ({
    page,
  }) => {
    // Arrange - 3 ページの ZIP。色でどのページか見分ける
    const archive = writeArchive(sidecar.workDir, "reorder.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
      { name: "003.jpg", color: "#0000ff" },
    ]);
    const before = coloursOf(archive);

    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&archive=${encodeURIComponent(archive)}`,
    );

    await page.getByTestId("split-step-split").click();

    // Assert - サムネイルが実際に描画される
    const cards = page.getByTestId("editable-page");
    await expect(cards).toHaveCount(3);
    await expect(cards.first()).toHaveAttribute("data-name", "001.jpg");
    const firstThumb = cards.first().locator("img");
    await expect
      .poll(() =>
        firstThumb.evaluate(
          (image: HTMLImageElement) =>
            image.naturalWidth >= image.getBoundingClientRect().width &&
            image.naturalWidth > 0,
        ),
      )
      .toBe(true);

    // Act - 1 枚目を 3 枚目の位置へドラッグする
    const source = cards.nth(0);
    const target = cards.nth(2);
    await source.getByTestId("page-drag-handle").hover();
    await page.mouse.down();
    const box = await target.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, {
      steps: 12,
    });
    await page.mouse.up();

    // Assert - 画面上の順序が変わり、未保存として示される
    await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");
    await expect(cards.nth(2)).toHaveAttribute("data-name", "001.jpg");

    // Act - 保存する。
    // dnd-kit はドラッグ終了から 50ms のあいだ click を document で止める。
    // 人はその間に押せないので、実際の操作と同じだけ間を空けてから押す
    await page.mouse.move(5, 5);
    await page.waitForTimeout(100);
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toContainText(
      "変更を反映しました",
    );

    // Assert - ZIP が実際に書き換わっている
    expect(pageEntriesOf(archive)).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
    const after = coloursOf(archive);
    expect(after["001.jpg"]).toBe(before["002.jpg"]);
    expect(after["002.jpg"]).toBe(before["003.jpg"]);
    expect(after["003.jpg"]).toBe(before["001.jpg"]);
  });

  test("接続情報が無いときは理由を示す", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("error")).toContainText(
      "接続情報がありません",
    );
  });

  test("読めないアーカイブを指定したときは理由を示す", async ({ page }) => {
    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&archive=${encodeURIComponent(sidecar.workDir + "/missing.zip")}`,
    );
    await expect(page.getByTestId("split-loading")).toContainText(
      "見つかりません",
    );
  });

  test("表示サイズを変えるとサムネイルの解像度が上がる", async ({ page }) => {
    const archive = writeArchive(sidecar.workDir, "resize.zip", [
      { name: "001.jpg", color: "#123456" },
    ]);
    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&archive=${encodeURIComponent(archive)}`,
    );
    const thumb = page.getByTestId("editable-page").first().locator("img");
    await expect
      .poll(() =>
        thumb.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    const initialWidth = await thumb.evaluate(
      (image: HTMLImageElement) => image.naturalWidth,
    );

    await page.getByTestId("split-card-width").fill("520");
    await expect
      .poll(() =>
        thumb.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(initialWidth);
  });
});

test.describe("複数選択・Undo・原寸表示", () => {
  async function openArchive(
    page: import("@playwright/test").Page,
    name: string,
  ) {
    const archive = writeArchive(sidecar.workDir, name, [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
      { name: "003.jpg", color: "#0000ff" },
      { name: "004.jpg", color: "#ffff00" },
    ]);
    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&archive=${encodeURIComponent(archive)}`,
    );
    await page.getByTestId("split-step-split").click();
    await expect(page.getByTestId("editable-page")).toHaveCount(4);
    return archive;
  }

  test("Ctrl クリックで複数選択し、まとめて移動できる", async ({ page }) => {
    await openArchive(page, "multi.zip");
    const cards = page.getByTestId("editable-page");

    // Act - 1 枚目と 2 枚目を選ぶ
    await cards.nth(0).click();
    await cards.nth(1).click({ modifiers: ["Control"] });
    await expect(page.getByTestId("selection-count")).toHaveText("2 件選択");

    // Act - 選択したまま 4 枚目の位置へドラッグする
    await cards.nth(0).getByTestId("page-drag-handle").hover();
    await page.mouse.down();
    const box = (await cards.nth(3).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 12,
    });
    await page.mouse.up();

    // Assert - 2 枚がまとまって末尾側へ移る
    await expect(cards.nth(0)).toHaveAttribute("data-name", "003.jpg");
    await expect(cards.nth(1)).toHaveAttribute("data-name", "004.jpg");
    await expect(cards.nth(2)).toHaveAttribute("data-name", "001.jpg");
    await expect(cards.nth(3)).toHaveAttribute("data-name", "002.jpg");
  });

  test("Shift クリックで範囲選択できる", async ({ page }) => {
    await openArchive(page, "range.zip");
    const cards = page.getByTestId("editable-page");

    await cards.nth(0).click();
    await cards.nth(2).click({ modifiers: ["Shift"] });

    await expect(page.getByTestId("selection-count")).toHaveText("3 件選択");
    await expect(cards.nth(1)).toHaveAttribute("data-selected", "true");
    await expect(cards.nth(3)).toHaveAttribute("data-selected", "false");
  });

  test("Ctrl+Z で並べ替えを元に戻せる", async ({ page }) => {
    await openArchive(page, "undo.zip");
    const cards = page.getByTestId("editable-page");

    // Act - 並べ替える
    await cards.nth(0).getByTestId("page-drag-handle").hover();
    await page.mouse.down();
    const box = (await cards.nth(2).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");

    // Act - 元に戻す
    await page.keyboard.press("Control+z");

    // Assert
    await expect(page.getByTestId("split-confirm")).toHaveText(
      "確認済みにする",
    );
    await expect(cards.nth(0)).toHaveAttribute("data-name", "001.jpg");
  });

  test("虫眼鏡で原寸表示し、Esc で閉じる", async ({ page }) => {
    await openArchive(page, "zoom.zip");

    // Act
    await page.getByTestId("editable-page").first().getByTestId("zoom").click();

    // Assert - サムネイル(240px)ではなく原寸(600px)が表示される
    const image = page.getByTestId("lightbox-image");
    await expect(image).toBeVisible();
    await expect(image).toHaveJSProperty("naturalWidth", 600);

    // Act / Assert
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("lightbox")).toBeHidden();
  });
});

test.describe("ページ並べ替えの対象選択", () => {
  /**
   * 実際のドロップを再現する。
   *
   * ブラウザは実パスを渡さないので、名前とサイズだけを持つ File を作って
   * drop イベントを投げる。アプリはその手がかりから実パスを引き当てる。
   * （e2e/drop.spec.ts と同じ経路）
   */
  async function dropFiles(
    page: Page,
    files: { name: string; size: number }[],
  ) {
    await page.dispatchEvent('[data-testid="dropzone"]', "drop", {
      dataTransfer: await page.evaluateHandle((entries) => {
        const transfer = new DataTransfer();
        for (const entry of entries) {
          transfer.items.add(
            new File([new Uint8Array(entry.size)], entry.name, {
              type: "application/zip",
            }),
          );
        }
        return transfer;
      }, files),
    });
  }

  /** 作った ZIP を、ドロップに渡す名前とサイズの組にする */
  function dropEntry(archive: string) {
    return {
      name: archive.split(/[\\/]/).pop()!,
      size: readFileSync(archive).length,
    };
  }

  /** 対象を選ばずにページ並べ替えを開く */
  async function openReorder(page: Page) {
    await page.goto(
      `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
        `&mode=reorder`,
    );
    await expect(page.getByTestId("mode-edit")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }

  /**
   * ファイルブラウザを辿って対象を 1 件選ぶ。
   *
   * organize.spec.ts の selectArchives() と同じ要領で、実パスはサーバー側が返す。
   */
  async function chooseArchiveViaBrowser(page: Page, archive: string) {
    const name = archive.split(/[\\/]/).pop()!;
    await page.getByTestId("open-browser").click();
    await expect(page.getByTestId("file-browser")).toBeVisible();
    await page
      .locator(
        `[data-testid="browse-entry"][data-name="${name}"] .browser-name`,
      )
      .click();
    await page.getByTestId("split-step-split").click();
  }

  /** カードを掴んで別のカードの位置まで運ぶ */
  async function dragCard(page: Page, from: number, to: number) {
    await page.getByTestId("split-step-split").click();
    const cards = page.getByTestId("editable-page");
    await cards.nth(from).getByTestId("page-drag-handle").hover();
    await page.mouse.down();
    const box = (await cards.nth(to).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
  }

  test("対象が選ばれていないときはドロップ領域が出る", async ({ page }) => {
    // Arrange / Act
    await openReorder(page);

    // Assert - その場で投入できる場所がある
    await expect(page.getByTestId("dropzone")).toBeVisible();

    // Assert - 利用者に URL を編集させる案内は出さない
    await expect(page.getByText(/URL に archive/)).toHaveCount(0);
  });

  test("ドロップした ZIP のページがサムネイルで並ぶ", async ({ page }) => {
    // Arrange - 3 ページの ZIP を作り、名前とサイズだけを渡せるようにする
    const archive = writeArchive(sidecar.workDir, "投入ドロップ.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
      { name: "003.jpg", color: "#0000ff" },
    ]);
    await openReorder(page);

    // Act
    await dropFiles(page, [dropEntry(archive)]);

    // Assert - 落とした 1 件が対象になり、そのページ数だけ並ぶ
    await expect(page.getByTestId("archive-name")).toHaveText(
      "投入ドロップ.zip",
    );
    const cards = page.getByTestId("editable-page");
    await expect(cards).toHaveCount(3);
    await expect(cards.first()).toHaveAttribute("data-name", "001.jpg");
  });

  test("ファイルを選ぶボタンから辿って対象にできる", async ({ page }) => {
    // Arrange
    const archive = writeArchive(sidecar.workDir, "投入ブラウザ.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
    ]);
    await openReorder(page);

    // Act
    await chooseArchiveViaBrowser(page, archive);

    // Assert
    await expect(page.getByTestId("archive-name")).toHaveText(
      "投入ブラウザ.zip",
    );
    await expect(page.getByTestId("editable-page")).toHaveCount(2);
  });

  test("投入から並べ替え、確定まで通しでできる", async ({ page }) => {
    // Arrange - 色でどのページか見分ける。書き換え前の日時も控えておく
    const archive = writeArchive(sidecar.workDir, "通し並べ替え.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
      { name: "003.jpg", color: "#0000ff" },
    ]);
    const before = coloursOf(archive);
    const entry = dropEntry(archive);
    const stamp = new Date("2020-01-02T03:04:05.000Z");
    utimesSync(archive, stamp, stamp);

    await openReorder(page);

    // Act - ドロップで投入する
    await dropFiles(page, [entry]);
    const cards = page.getByTestId("editable-page");
    await expect(cards).toHaveCount(3);

    // Act - 1 枚目を 3 枚目の位置へ運ぶ
    await dragCard(page, 0, 2);
    await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");
    await expect(cards.nth(2)).toHaveAttribute("data-name", "001.jpg");

    // Act - 保存する。
    // dnd-kit はドラッグ終了から 50ms のあいだ click を document で止める。
    // 人はその間に押せないので、実際の操作と同じだけ間を空けてから押す
    await page.mouse.move(5, 5);
    await page.waitForTimeout(100);
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toContainText(
      "変更を反映しました",
    );

    // Assert - ZIP は連番のまま、中身が入れ替わっている
    expect(pageEntriesOf(archive)).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
    const after = coloursOf(archive);
    expect(after["001.jpg"]).toBe(before["002.jpg"]);
    expect(after["002.jpg"]).toBe(before["003.jpg"]);
    expect(after["003.jpg"]).toBe(before["001.jpg"]);

    // Assert - 書き換えてもファイルの更新日時は変わらない
    expect(statSync(archive).mtimeMs).toBe(stamp.getTime());
  });

  test("別のファイルを選び直すと前の編集は持ち越さない", async ({ page }) => {
    // Arrange - 1 つ目は 3 ページ、2 つ目は 4 ページで見分ける
    const first = writeArchive(sidecar.workDir, "選び直し 1.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
      { name: "003.jpg", color: "#0000ff" },
    ]);
    const second = writeArchive(sidecar.workDir, "選び直し 2.zip", [
      { name: "001.jpg", color: "#ffff00" },
      { name: "002.jpg", color: "#ff00ff" },
      { name: "003.jpg", color: "#00ffff" },
      { name: "004.jpg", color: "#123456" },
    ]);
    await openReorder(page);
    await dropFiles(page, [dropEntry(first)]);
    const cards = page.getByTestId("editable-page");
    await expect(cards).toHaveCount(3);

    // Arrange - 1 つ目で並べ替えて未保存の編集を作る
    await dragCard(page, 0, 2);
    await expect(page.getByTestId("split-confirm")).toHaveText("変更を反映");

    // Act - 2 つ目に選び直す。
    // dnd-kit はドラッグ終了から 50ms のあいだ click を document で止める。
    // 人はその間に押せないので、実際の操作と同じだけ間を空けてから押す
    await page.mouse.move(5, 5);
    await page.waitForTimeout(100);
    await page.getByTestId("change-archive").click();
    await expect(page.getByTestId("dropzone")).toBeVisible();
    await chooseArchiveViaBrowser(page, second);

    // Assert - 2 つ目のページが並ぶ
    await expect(page.getByTestId("archive-name")).toHaveText("選び直し 2.zip");
    await expect(cards).toHaveCount(4);

    // Assert - 1 つ目の編集は残っていない
    await expect(page.getByTestId("split-confirm")).toHaveText(
      "確認済みにする",
    );
    await expect(cards.nth(0)).toHaveAttribute("data-name", "001.jpg");
    await expect(cards.nth(3)).toHaveAttribute("data-name", "004.jpg");
  });

  test("複数まとめて落としたら先頭の 1 件だけを対象にする", async ({
    page,
  }) => {
    // Arrange - ページ数を変えて、どちらが対象か中身からも分かるようにする
    const head = writeArchive(sidecar.workDir, "まとめ投入 先頭.zip", [
      { name: "001.jpg", color: "#ff0000" },
      { name: "002.jpg", color: "#00ff00" },
    ]);
    const tail = writeArchive(sidecar.workDir, "まとめ投入 後続.zip", [
      { name: "001.jpg", color: "#0000ff" },
      { name: "002.jpg", color: "#ffff00" },
      { name: "003.jpg", color: "#ff00ff" },
    ]);
    await openReorder(page);

    // Act
    await dropFiles(page, [dropEntry(head), dropEntry(tail)]);

    // Assert - 先頭の 1 件が対象で、どれを使ったかが画面から分かる
    await expect(page.getByTestId("archive-name")).toHaveText(
      "まとめ投入 先頭.zip",
    );
    await expect(page.getByTestId("editable-page")).toHaveCount(2);
  });
});

/**
 * 表示サイズの置き場所と密度（UI 刷新の第 4 段階）。
 *
 * 決めたことは 3 つ。
 * 1. 画面固有の操作を共通ヘッダーに置かない。他の 2 画面と構造を揃え、
 *    表示サイズはページ並べ替えのツールバーへ移す
 * 2. 単行本は 150〜200 ページある。1 行 5 枚では全体を見渡せないので、
 *    既定を密（1 行 7〜8 枚）にする
 * 3. 表示の好みは画面側の設定。再読み込みや画面の行き来で消えない
 *
 * 測るのは利用者から見える結果だけにする。どこに保存したか（localStorage か
 * サイドカーか）は実装の選択であり、ここで縛ると保存先を変えた瞬間に壊れる。
 * 「動かした後の見え方が残っているか」だけを見る。
 */

/** 実際に使う窓の大きさ。承認された受け入れ基準がこの寸法で書かれている */
const REORDER_VIEWPORT = { width: 1280, height: 860 };

/** 密度を測るためのページ数。1 行 8 枚でも 3 行に届き、行の切れ目が見える */
const DENSE_PAGE_COUNT = 24;

/**
 * 既定で 1 行に並ぶべき枚数の下限。
 *
 * 1280px の窓では作業面（p-3 の内側）が 1256px、カードの間隔が 12px。
 * n 枚並べるにはカード幅が (1256 + 12) / n - 12 以下である必要がある。
 * 7 枚なら 169px 以下、8 枚なら 146px 以下。現行のスライダーは
 * min=140 step=20 なので、140 で 8 枚、160 で 7 枚に届く。
 * 目標は現行の可動域の中で到達できる（実測で確認済み）。
 */
const MIN_CARDS_PER_ROW = 7;

/**
 * 同じく上限。
 *
 * 「密にする」を、判別できない大きさまで縮めることや、1 行に全ページを
 * 流す横スクロールの帯にすることで満たされないようにする。承認された値は
 * 7〜8 枚なので、端の実装差を見込んでも 10 枚を超えていれば行き過ぎ。
 */
const MAX_CARDS_PER_ROW = 10;

/** 同じ行とみなす y 座標のずれ。小数の丸めのぶんだけ許す */
const ROW_TOLERANCE = 2;

type GridLayout = {
  total: number;
  inFirstRow: number;
  cardWidth: number;
  template: string;
};

/**
 * ツールバーの中身。
 *
 * ツールバーには testid が無く、クラス名（flex flex-wrap ...）は今回
 * 書き換わる所なので目印にしない。対象ファイル名と保存ボタンの両方を含む
 * 一番内側の祖先、という位置関係で辿る（density.spec.ts の
 * installContentRoot() と同じ要領）。
 */
/**
 * サムネイルの並びを測る。
 *
 * 1 行の枚数は、最初のカードと同じ y 座標にあるカードの数で数える。
 * grid の列指定を読むとカードが 1 枚も無くても数が出てしまうので、
 * 実際に置かれたカードの座標だけを見る。
 */
async function gridLayout(page: Page): Promise<GridLayout> {
  const measured = await page.evaluate((tolerance) => {
    const cards = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="editable-page"]',
      ),
    ];
    if (cards.length === 0) return null;
    const first = cards[0].getBoundingClientRect();
    return {
      total: cards.length,
      inFirstRow: cards.filter(
        (card) =>
          Math.abs(card.getBoundingClientRect().top - first.top) <= tolerance,
      ).length,
      cardWidth: Math.round(first.width * 100) / 100,
      template: getComputedStyle(cards[0].parentElement!).gridTemplateColumns,
    };
  }, ROW_TOLERANCE);

  // カードが 1 枚も無いまま「1 行 0 枚」で通らないようにする
  expect(measured, "サムネイルが 1 枚も描画されていない").not.toBeNull();
  return measured!;
}

/** 密度を測るためのアーカイブを開く。ページが並びきるまで待つ */
async function openDenseArchive(page: Page, archive: string): Promise<void> {
  await page.setViewportSize(REORDER_VIEWPORT);
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&archive=${encodeURIComponent(archive)}`,
  );
  await page.getByTestId("split-step-split").click();
  await expect(page.getByTestId("editable-page")).toHaveCount(DENSE_PAGE_COUNT);
}

/**
 * スライダーを動かし、並びが実際に組み替わるまで待つ。
 *
 * fill() の直後に測ると、再描画前の座標を読んでしまうことがある。
 * 列の指定が変わったことを見てから測る。
 */
async function moveSlider(page: Page, value: string): Promise<GridLayout> {
  const before = await gridLayout(page);
  await page.getByTestId("split-card-width").fill(value);
  await page.waitForFunction(
    (previous) =>
      getComputedStyle(
        document.querySelector<HTMLElement>('[data-testid="editable-page"]')!
          .parentElement!,
      ).gridTemplateColumns !== previous,
    before.template,
  );
  return gridLayout(page);
}

test.describe("ページ並べ替えの表示サイズ", () => {
  let denseArchive: string;

  test.beforeAll(() => {
    denseArchive = writeArchive(
      sidecar.workDir,
      "密度確認.zip",
      Array.from({ length: DENSE_PAGE_COUNT }, (_, index) => ({
        name: `${String(index + 1).padStart(3, "0")}.jpg`,
        color: "#ff0000",
      })),
    );
  });

  test("表示サイズのスライダーが共通ヘッダーの中に無い", async ({ page }) => {
    // Arrange
    await openDenseArchive(page, denseArchive);

    // Assert - スライダーごと消して通らないようにする。
    // 画面のどこかに 1 つだけあることが前提
    await expect(page.getByTestId("split-card-width")).toHaveCount(1);

    // Assert - ヘッダーそのものは残っている（測る対象が消えていない）
    const header = page.locator("header");
    await expect(header).toBeVisible();
    await expect(header.getByTestId("mode-edit")).toHaveCount(1);

    // Assert - 画面固有の操作はヘッダーに置かない
    await expect(
      header.getByTestId("split-card-width"),
      "表示サイズのスライダーが共通ヘッダーの中にある",
    ).toHaveCount(0);
  });

  test("格子をいちばん下まで送っても、保存と表示サイズが見えている", async ({
    page,
  }) => {
    // Arrange
    await openDenseArchive(page, denseArchive);

    // Act - 格子を最後のページまで送る
    await page.getByTestId("editable-page").last().scrollIntoViewIfNeeded();

    // Assert - 流れるのは格子だけ。見出しの行が一緒に流れると、保存や
    // 表示サイズのたびに一番上まで戻ることになる（#129）
    await expect(
      page.getByTestId("editable-page").first(),
    ).not.toBeInViewport();
    await expect(page.getByTestId("split-confirm")).toBeInViewport();
    await expect(page.getByTestId("split-card-width")).toBeInViewport();
  });

  test(`既定でサムネイルが 1 行に ${MIN_CARDS_PER_ROW} 枚以上並ぶ`, async ({
    page,
  }) => {
    // Arrange - スライダーには触れない。開いた直後の見え方を測る
    await openDenseArchive(page, denseArchive);

    // Act
    const layout = await gridLayout(page);

    // Assert - 全ページが並んでいる（数え漏らしたまま通らないようにする）
    expect(layout.total).toBe(DENSE_PAGE_COUNT);

    // Assert - 150〜200 ページを見渡せる密度が既定になっている
    expect(
      layout.inFirstRow,
      `既定で 1 行 ${layout.inFirstRow} 枚（カード幅 ${layout.cardWidth}px）`,
    ).toBeGreaterThanOrEqual(MIN_CARDS_PER_ROW);

    // Assert - 判別できない大きさまで縮めたり、1 行に全ページを流す帯に
    // したりして満たさない
    expect(
      layout.inFirstRow,
      `既定で 1 行 ${layout.inFirstRow} 枚（カード幅 ${layout.cardWidth}px）は詰め過ぎ`,
    ).toBeLessThanOrEqual(MAX_CARDS_PER_ROW);
  });

  test("表示サイズを大きくすると 1 行の枚数が減る", async ({ page }) => {
    // Arrange
    await openDenseArchive(page, denseArchive);
    const before = await gridLayout(page);
    const slider = page.getByTestId("split-card-width");
    const max = await slider.getAttribute("max");
    expect(max, "スライダーに上限が無い").not.toBeNull();

    // Act - 可動域の端まで大きくする。既定値に依らず必ず「大きくする」になる
    const after = await moveSlider(page, max!);

    // Assert - 操作そのものが効いている
    await expect(slider).toHaveValue(max!);

    // Assert - 大きくしたぶんだけ 1 行に入らなくなる
    expect(
      after.inFirstRow,
      `${before.inFirstRow} 枚（幅 ${before.cardWidth}px）から` +
        `${after.inFirstRow} 枚（幅 ${after.cardWidth}px）へ変わっていない`,
    ).toBeLessThan(before.inFirstRow);
    expect(after.cardWidth).toBeGreaterThan(before.cardWidth);
  });

  test("表示サイズの設定が再読み込み後も残る", async ({ page }) => {
    // Arrange - 動かす前の見え方を控える
    await openDenseArchive(page, denseArchive);
    const initial = await gridLayout(page);
    const max = await page.getByTestId("split-card-width").getAttribute("max");
    expect(max).not.toBeNull();

    // Act - 利用者が表示サイズを決める
    const moved = await moveSlider(page, max!);
    expect(
      moved.inFirstRow,
      "動かしても見え方が変わっておらず、残ったかどうか区別できない",
    ).not.toBe(initial.inFirstRow);

    // Act - アプリを開き直したときと同じ状態にする
    await page.reload();
    await expect(page.getByTestId("editable-page")).toHaveCount(
      DENSE_PAGE_COUNT,
    );

    // Assert - 保存先の実装ではなく、利用者から見える結果で確かめる
    const reloaded = await gridLayout(page);
    expect(
      reloaded.inFirstRow,
      `再読み込みで 1 行 ${moved.inFirstRow} 枚から ${reloaded.inFirstRow} 枚へ戻った` +
        `（開いた直後は ${initial.inFirstRow} 枚）`,
    ).toBe(moved.inFirstRow);

    // Assert - スライダーのつまみの位置も、利用者が決めた所のまま
    await expect(page.getByTestId("split-card-width")).toHaveValue(max!);
  });

  test("表示サイズの設定が画面を移って戻っても残る", async ({ page }) => {
    // Arrange
    await openDenseArchive(page, denseArchive);
    const initial = await gridLayout(page);
    const max = await page.getByTestId("split-card-width").getAttribute("max");
    expect(max).not.toBeNull();

    const backToReorder = async () => {
      await page.getByTestId("mode-organize").click();
      // 画面を移っても格子は作り直されず隠れるだけになった（#67）ので、
      // カードは DOM に残る。離れたことは見えているかどうかで確かめる。
      // カードは 1 つの入れ物ごと隠れるため、先頭を見れば全体が分かる
      await expect(page.getByTestId("editable-page").first()).toBeHidden();
      await page.getByTestId("mode-edit").click();
      await expect(page.getByTestId("editable-page")).toHaveCount(
        DENSE_PAGE_COUNT,
      );
      return gridLayout(page);
    };

    // Act - 表示サイズを決める
    const moved = await moveSlider(page, max!);
    expect(
      moved.inFirstRow,
      "動かしても見え方が変わっておらず、残ったかどうか区別できない",
    ).not.toBe(initial.inFirstRow);

    // Act & Assert - ファイル整理へ移って戻る。
    // 表示サイズをツールバー（PageGrid）へ移すと、この往復で画面ごと
    // 作り直される。今は App が値を持っているので往復では消えない
    const returned = await backToReorder();
    expect(
      returned.inFirstRow,
      `画面を往復したら 1 行 ${moved.inFirstRow} 枚から ${returned.inFirstRow} 枚へ戻った`,
    ).toBe(moved.inFirstRow);

    // Act & Assert - 開き直してからもう一度往復する。
    // 「別の画面を開いたままアプリを閉じ、次に開いて戻ってくる」使い方
    await page.reload();
    await expect(page.getByTestId("editable-page")).toHaveCount(
      DENSE_PAGE_COUNT,
    );
    const afterRestart = await backToReorder();
    expect(
      afterRestart.inFirstRow,
      `開き直して往復したら 1 行 ${moved.inFirstRow} 枚から ${afterRestart.inFirstRow} 枚へ戻った` +
        `（開いた直後は ${initial.inFirstRow} 枚）`,
    ).toBe(moved.inFirstRow);
  });
});
