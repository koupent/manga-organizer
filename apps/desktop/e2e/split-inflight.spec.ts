import { expect, test, type Page, type Route } from "@playwright/test";
import {
  derivedRecordsOf,
  pageEntriesOf,
  pageSizesOf,
  runPython,
} from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * ページ分割の、走っている最中の始末（#58 段階 3）。
 *
 * 割る作業は 2 つの長いジョブでできている。開いたときの走査（数百枚を
 * 1 枚ずつ開く）と、確定の書き込み（ZIP を丸ごと書き直す）。どちらも
 * 秒の単位で走るので、その最中に利用者が次の操作をする余地がある。
 *
 * ここで確かめるのは 2 つ。
 *
 * 1. 書き込みが終わって新しい行が並ぶまで、主操作は押せないままであること。
 *    途中で押せるようになると、同じ本へ 2 つの書き込みが走る。どちらも
 *    走査の印を通ってしまうので、後から出した指示が先に着いた指示に
 *    上書きされる。利用者は自分が最後に選んだ内容と違う本を手にする
 * 2. 見捨てた走査は番号で名指しして止めること。止めないと、もう誰も
 *    見ていない全ページの走査が裏で走り続け、次の本の走査と重なる
 *
 * 待ち時間は page.route で作る。偶然その瞬間を捉えられる回を待つのではなく、
 * 「まだ終わっていない」ことをこちらで決めて再現する（cover-stale.spec.ts と
 * 同じ作り）。応答そのものは本物のサイドカーのままにする。
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 見開きの寸法。比 1.333 で閾値（1.2）の上 */
const SPREAD = [2400, 1800];

/** 判定から漏れる横長。比 1.15 は閾値の下。手でチェックを入れる相手に使う */
const NEAR_SPREAD = [1380, 1200];

/** 割る前・割った後のページ数 */
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

const tall = (colour: string) => ({ kind: "flat", w: 1200, h: 1800, colour });

/**
 * 2 枚目が見開き、4 枚目が判定から漏れる横長の本。
 *
 * 4 枚目を入れてあるのが要点。書き込みの最中に触る相手がここで、割られたか
 * どうかが寸法にそのまま残る。全部が縦長の本だと、2 度目の書き込みが通っても
 * 結果が変わらず、race が起きたことを本の側から見分けられない。
 */
function writeMixedArchive(name: string): string {
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
      { kind: "flat", w: NEAR_SPREAD[0], h: NEAR_SPREAD[1], colour: "#ff00ff" },
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

/** 送られた POST の経路だけを控える */
function recordPosts(page: Page): string[] {
  const posted: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    posted.push(new URL(request.url()).pathname);
  });
  return posted;
}

/* --- 主操作の様子を見張る ------------------------------------------------ */

/** 見張りが取った 1 標本 */
type Sample = { phase: string; enabled: boolean; count: string };

/** 標本を取る間隔（ms）。押せる窓が 0.5 秒でも 20 回は当たる細かさ */
const SAMPLE_INTERVAL_MS = 25;

type SamplerWindow = Window & {
  __splitPhase: string;
  __splitSamples: Sample[];
  __splitTimer: number;
};

/**
 * 主操作が押せるかどうかを、一定の間隔で控え続ける。
 *
 * ある瞬間に押せないことを 1 回見るだけでは足りない。書き込みが終わるまでの
 * あいだ一度も押せなかったことを言うには、その窓の全体を見張るしかない。
 * 局面（phase）を添えるのは、押して当たり前の「押す前」を混ぜないため。
 */
async function startSampler(page: Page) {
  await page.evaluate((interval) => {
    const scope = window as unknown as SamplerWindow;
    scope.__splitPhase = "before";
    scope.__splitSamples = [];
    scope.__splitTimer = window.setInterval(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="split-confirm"]',
      );
      const count = document.querySelector<HTMLElement>(
        '[data-testid="split-page-count"]',
      );
      scope.__splitSamples.push({
        phase: scope.__splitPhase,
        enabled: button !== null && !button.disabled,
        count: count?.textContent?.trim() ?? "",
      });
    }, interval);
  }, SAMPLE_INTERVAL_MS);
}

async function setPhase(page: Page, phase: string) {
  await page.evaluate((next) => {
    (window as unknown as SamplerWindow).__splitPhase = next;
  }, phase);
}

async function stopSampler(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const scope = window as unknown as SamplerWindow;
    window.clearInterval(scope.__splitTimer);
    return scope.__splitSamples;
  });
}

/* --- 1. 書き込みの最中に触っても、主操作は押せないまま ------------------- */

/** 確定の投入を遅らせる時間。書き込みの最中に何度も操作できる長さ */
const CONFIRM_DELAY_MS = 2_500;

test.describe("ページ分割: 書き込みの最中に触る", () => {
  test("書き込みが終わって行が並び直すまで、確定は押せないまま", async ({
    page,
  }) => {
    // Arrange - 確定の投入を遅らせ、書き込みの最中を取り逃がさないようにする。
    // 応答は本物のまま。作り物を返すと、本が実際にどうなったかを見られない
    const archive = writeMixedArchive("書き込み中の編集.zip");
    const posted = recordPosts(page);
    await page.route(/\/api\/jobs\/split(\?|$)/, async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_DELAY_MS));
      await route.continue();
    });
    await openSplit(page, archive, BEFORE_PAGES);
    await page.getByTestId("split-all").click();

    // Arrange - 見張りを立て、「押せる」を実際に観測できることを確かめる。
    // ここが取れないと、以降の「一度も押せなかった」は見張りが壊れている
    // だけでも成り立ってしまう
    const confirm = page.getByTestId("split-confirm");
    await startSampler(page);
    await page.waitForTimeout(200);
    expect(await confirm.isEnabled(), "押す前から確定が押せない").toBe(true);

    // Act - 確定する。投入は遅れるので、書き込みはまだ始まっていない
    await confirm.click();
    await expect(page.getByTestId("split-status")).toHaveAttribute(
      "data-state",
      "running",
    );
    await setPhase(page, "inflight");

    // Act - 書き込みの最中に、見逃した見開きのつもりで 4 枚目へチェックを
    // 入れる。押せなくしてある作りでも落ちないよう force で押す
    await cardAt(page, 3).getByTestId("split-check").click({ force: true });
    await page.waitForTimeout(50);
    const disabledAfterEdit = await confirm.isDisabled();

    // 制御 - この時点で本はまだ書き換わっていない。書き換わっていれば、
    // 「書き込みの最中に触った」ことになっていない
    expect(
      pageEntriesOf(archive),
      "投入が遅れておらず、書き込みの最中を捉えられていない",
    ).toHaveLength(BEFORE_PAGES);

    // Act - しばらく置いてから、利用者と同じように押す。押せる作りなら
    // ここで 2 つ目の書き込みが投入される
    await page.waitForTimeout(500);
    const disabledBeforeSecondPress = await confirm.isDisabled();
    await confirm.click({ force: true });

    // Act - 書き込みが終わり、読み直した行が並ぶまで待つ
    await expect(page.getByTestId("split-page-count")).toHaveText(
      `${AFTER_PAGES} ページ`,
      { timeout: 30_000 },
    );
    await setPhase(page, "after");
    const samples = await stopSampler(page);

    // Assert - 見張りは働いていた。押す前は押せていて、書き込み中の窓も
    // 十分な回数を観測している
    expect(
      samples.some((sample) => sample.phase === "before" && sample.enabled),
      "見張りが「押せる」を一度も観測していない。検証として成立しない",
    ).toBe(true);
    const inFlight = samples.filter(
      (sample) =>
        sample.phase === "inflight" &&
        sample.count === `${BEFORE_PAGES} ページ`,
    );
    expect(
      inFlight.length,
      `書き込み中の窓を ${inFlight.length} 回しか観測できていない`,
    ).toBeGreaterThan(40);

    // Assert - その窓のあいだ、確定は一度も押せていない。ある瞬間だけを
    // 見る検証は、たまたま押せない瞬間に当たっただけでも通ってしまう
    const submitted = posted.filter((path) => path.endsWith("/api/jobs/split"));
    expect(
      inFlight.filter((sample) => sample.enabled).length,
      `書き込みが終わる前に確定が押せるようになっている（確定の投入は ${submitted.length} 回）`,
    ).toBe(0);
    expect(disabledAfterEdit, "チェックを触った直後に確定が押せる").toBe(true);
    expect(disabledBeforeSecondPress).toBe(true);

    // Assert - 書き込みは 1 回しか投入されていない。押せてしまえば、
    // 同じ本へ 2 つの指示が飛び、着いた順で結果が決まる
    expect(submitted, "確定が 2 回投入されている").toHaveLength(1);

    // Assert - 本の側も 1 回ぶんの分割で終わっている
    const entries = pageEntriesOf(archive);
    expect(entries, "分割が 1 回ぶんになっていない").toHaveLength(AFTER_PAGES);
    expect(
      Object.keys(derivedRecordsOf(archive)),
      "割った跡の記録が 1 枚ぶん（2 件）になっていない",
    ).toHaveLength(2);

    // Assert - 書き込みの最中に触った 4 枚目は割られていない。枚数だけを
    // 見ると、2 度目の書き込みが別の所を割っていても数が合うことがある
    const sizes = pageSizesOf(archive);
    expect(
      Object.values(sizes),
      "書き込みの最中に入れたチェックが、そのまま本へ書かれている",
    ).toContainEqual(NEAR_SPREAD);
  });
});

/* --- 2. 見捨てた走査を止める --------------------------------------------- */

/** 走査ジョブの状態取得を握る仕掛け。テストの側から離す */
type Gate = { wait: Promise<void>; release: () => void };

function makeGate(): Gate {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

/** 対象を選び直す画面から、名前で 1 件選ぶ（page-reorder.spec.ts と同じ要領） */
async function chooseArchiveViaBrowser(page: Page, archive: string) {
  const name = archive.split("/").pop()!;
  await page.getByTestId("open-browser").click();
  await expect(page.getByTestId("file-browser")).toBeVisible();
  await page
    .locator(`[data-testid="browse-entry"][data-name="${name}"] .browser-name`)
    .click();
}

test.describe("ページ分割: 見捨てた走査", () => {
  test("対象を選び直すと、走ったままの走査を番号で名指しして止める", async ({
    page,
  }) => {
    // Arrange - 走査ジョブの番号を投入順に控え、2 本目の状態取得だけを握る。
    // 2 本目は確定の直後に走り直す走査で、そのあいだ画面には
    // 「別のファイルを選ぶ」が出ている。利用者が次の巻へ移ろうとする所
    const archive = writeMixedArchive("走査を見捨てる.zip");
    const next = writeMixedArchive("次の巻.zip");
    const scans: string[] = [];
    const gate = makeGate();
    const posted = recordPosts(page);
    // 途中で落ちても握ったままにしない。握ったままだと、後片付けが
    // 本題より長く待たされ、失敗の理由が待ち時間に埋もれる
    page.on("close", () => gate.release());

    await page.route("**/api/jobs/**", async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (
        request.method() === "POST" &&
        path.endsWith("/api/jobs/split-scan")
      ) {
        // 番号は画面より先に控える。控える前に状態取得が始まると、
        // 握るつもりの往復を取り逃がす
        const response = await route.fetch();
        const body = (await response.json()) as { id: string };
        scans.push(body.id);
        await route.fulfill({ response });
        return;
      }
      if (request.method() === "GET" && path === `/api/jobs/${scans[1]}`) {
        await gate.wait;
      }
      try {
        await route.continue();
      } catch {
        // 画面が離れて中断された往復。ここで落とすと後片付けが本題を隠す
      }
    });

    await openSplit(page, archive, BEFORE_PAGES);
    await page.getByTestId("split-all").click();

    // Act - 割る。確定の後、画面は走査をやり直す（2 本目）
    await page.getByTestId("split-confirm").click();
    await expect(page.getByTestId("split-status")).toHaveAttribute(
      "data-state",
      "done",
      { timeout: 30_000 },
    );
    await expect
      .poll(() => scans.length, {
        message: "確定の後に走査がやり直されていない",
        timeout: 15_000,
      })
      .toBe(2);

    // 制御 - 2 本目はまだ終わっていない。ページ数が割る前のままなのが
    // その証拠。終わっていれば、止める相手が存在しない
    await expect(page.getByTestId("split-page-count")).toHaveText(
      `${BEFORE_PAGES} ページ`,
    );
    expect(scans[1], "同じ走査の番号を数えている").not.toBe(scans[0]);

    // Act - 走査が終わらないうちに、別のファイルを選び直す
    await page.getByTestId("change-archive").click();
    await expect(page.getByTestId("dropzone")).toBeVisible();

    // Assert - 走ったままの走査を、番号で名指しして止める。「どれかが
    // 止められた」では足りない。画面を捨てるときには他のジョブも止めうるので、
    // 番号を見ない検証は別の後片付けでも通ってしまう
    await expect
      .poll(() => posted, {
        message: `見捨てた走査 (${scans[1]}) を止めていない`,
        timeout: 15_000,
      })
      .toContain(`/api/jobs/${scans[1]}/cancel`);

    // Act - 次の本を選ぶ。3 本目の走査が始まる
    await chooseArchiveViaBrowser(page, next);
    await expect(cardsOf(page)).toHaveCount(BEFORE_PAGES, { timeout: 30_000 });
    expect(scans, "次の本の走査が投入されていない").toHaveLength(3);

    // Assert - 止めたのは見捨てた方で、いま見ている本の走査は走ったまま。
    // 上の検証が 3 本目の後片付けで満たされていないことを確かめる
    expect(scans[2]).not.toBe(scans[1]);
    expect(posted, "いま見ている本の走査まで止めている").not.toContain(
      `/api/jobs/${scans[2]}/cancel`,
    );

    gate.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});
