import { expect, test, type Page, type Route } from "@playwright/test";
import { pageEntriesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 分割を書き込んだ後の、読み直しが失敗したとき（#58 段階 3）。
 *
 * 確定は「書き込む」だけでは終わらない。書き込むと連番も行の畳み方も変わるので、
 * 画面は必ず走査をやり直し、新しい行を並べて初めて次の操作を受け付けられる。
 *
 * その走査が失敗したとき、画面に残っているのは書き込む前の行――もう本には
 * 無い名前と、たったいま書き込んだばかりの保留――になる。ここで主操作が
 * 生き返ると、利用者は「まだ割れていないのだろう」と思ってもう一度押す。
 * 送られるのは古い印と古い名前なので、断られるか、通ってしまえば割った
 * 半分をさらに割った本が残る。どちらにしても、割り直しでは戻せない。
 *
 * 失敗はこちらで作る。偶然サイドカーが落ちる回を待つのではなく、
 * 「書き込みの後の走査だけが落ちた」ことを決めて再現する
 * （split-inflight.spec.ts と同じ作り）。
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

/** 見張る長さ（ms）と間隔。押せる窓が一瞬でも開けば当たる細かさ */
const WATCH_MS = 1_500;
const SAMPLE_INTERVAL_MS = 25;

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

/** 2 枚目だけが見開きの本。割ると 5 ページが 6 ページになる */
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

function cardsOf(page: Page) {
  return page.locator('[data-testid="split-card"]');
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

/** 送られた POST の経路だけを控える */
function recordPosts(page: Page): string[] {
  const posted: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    posted.push(new URL(request.url()).pathname);
  });
  return posted;
}

/**
 * 主操作が押せるかどうかを、一定の間隔で控え続ける。
 *
 * ある瞬間に押せないことを 1 回見るだけでは足りない。読み直しが失敗した後
 * ずっと押せないことを言うには、その窓の全体を見張るしかない。
 *
 * 押す所ごと消して失敗を告げる作りもありうるので、無い場合は「押せない」
 * として数える。
 */
async function watchConfirm(page: Page, duration: number): Promise<boolean[]> {
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

/** いま主操作を押せるか。押せない状態で force クリックしても何も起きない */
async function confirmIsPressable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="split-confirm"]',
    );
    return button !== null && !button.disabled;
  });
}

/**
 * 失敗が画面に出ているか。
 *
 * 出し方は 2 通りありうる。行を並べたまま状態欄で告げるか、行ごと引っ込めて
 * 読み込み中の場所で告げるか。どちらでも利用者には届くので両方を認め、
 * 「読み込んでいます...」のままなのは失敗を告げていないものとして数える。
 */
async function failureIsShown(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const status = document.querySelector<HTMLElement>(
      '[data-testid="split-status"]',
    );
    if (status?.dataset.state === "error") return true;
    const loading = document.querySelector<HTMLElement>(
      '[data-testid="split-loading"]',
    );
    const text = loading?.textContent?.trim() ?? "";
    return text.length > 0 && !text.includes("読み込んでいます");
  });
}

test.describe("ページ分割: 書き込んだ後の走査が失敗したとき", () => {
  test("読み直せなかったら、古い行のまま確定を押し直させない", async ({
    page,
  }) => {
    // Arrange - 落とすのは「書き込みが通った後の」走査だけ。開いたときの
    // 走査まで落とすと、行が 1 つも並ばず、確かめたい状態に辿り着けない
    const archive = writeSpreadArchive("走査の失敗.zip");
    const posted = recordPosts(page);
    let armed = false;
    let blocked = 0;
    await page.route(/\/api\/jobs\/split(-scan)?\?/, async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.endsWith("/api/jobs/split")) {
        armed = true;
        await route.continue();
        return;
      }
      if (
        armed &&
        request.method() === "POST" &&
        path.endsWith("/api/jobs/split-scan")
      ) {
        blocked += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "見開きを調べられませんでした（検証）",
          }),
        });
        return;
      }
      await route.continue();
    });

    await openSplit(page, archive, BEFORE_PAGES);
    await page.getByTestId("split-all").click();

    // 制御 - 見張りが「押せる」を観測できている。ここが取れないと、後の
    // 「一度も押せなかった」は見張りが壊れているだけでも成り立つ
    expect(
      (await watchConfirm(page, 300)).some(Boolean),
      "押す前から確定が押せない。見張りとして成立しない",
    ).toBe(true);

    // Act - 確定する。書き込みは通り、その後の走査だけが落ちる
    await page.getByTestId("split-confirm").click();
    await expect
      .poll(() => blocked, {
        message: "書き込みの後の走査を落とせていない",
        timeout: 30_000,
      })
      .toBe(1);

    // 制御 - 書き込みは本当に通っている。通っていなければ、これは
    // 「確定が失敗しただけ」の画面で、保留が残っているのは正しい
    expect(
      pageEntriesOf(archive),
      "分割が本を書き換えていない。読み直しの失敗を見ていない",
    ).toHaveLength(AFTER_PAGES);

    // Assert - 失敗は黙って起きない。何が起きたのか分からないまま止まると、
    // 利用者は割れなかったと思って押し直す
    await expect
      .poll(() => failureIsShown(page), {
        message: "走査に失敗したことが画面のどこにも出ていない",
        timeout: 10_000,
      })
      .toBe(true);

    // Assert - 押せる状態に戻さない。並んでいるのは書き込む前の行で、
    // その名前も走査の印ももう古い。ここで押せると、割った半分をさらに
    // 割る指示が飛びうる
    const samples = await watchConfirm(page, WATCH_MS);
    expect(
      samples.length,
      `走査が失敗した後の窓を ${samples.length} 回しか観測できていない`,
    ).toBeGreaterThan(40);
    expect(
      samples.filter(Boolean).length,
      "走査に失敗した後、書き込む前の行のまま確定を押せる",
    ).toBe(0);

    // Assert - 利用者と同じように押しても、2 度目は投入されない。
    // 「失敗を出したうえで押させる」実装を、文の検証だけで通さない
    if (await confirmIsPressable(page)) {
      await page.getByTestId("split-confirm").click({ force: true });
    }
    await page.waitForTimeout(1_000);
    expect(
      posted.filter((path) => path.endsWith("/api/jobs/split")),
      "古い行のまま 2 度目の書き込みが投入されている",
    ).toHaveLength(1);

    // Assert - 本の側も 1 回ぶんの分割で終わっている。投入の数だけを見ると、
    // 断られた 2 度目が本を壊していないことまでは言えない
    expect(
      pageEntriesOf(archive),
      "2 度目の書き込みが本へ届いている",
    ).toHaveLength(AFTER_PAGES);

    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});
