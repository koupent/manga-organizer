import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 作品名から著者を引く一式（`src/hooks/useAuthorLookup.ts`）の、間引きと
 * 世代の判定を固定する。
 *
 * この一式は 3 つの仕掛けを持つ。
 *
 * 1. デバウンス（SEARCH_DELAY_MS）… 打つたびに問い合わせない
 * 2. 世代の握り潰し（searchSeq）… 遅れて届いた古い応答を、結果の反映も
 *    「検索中」の終わりも含めて捨てる
 * 3. authorChosen … 利用者が決めた著者を、遅れて届いた応答で覆さない
 *
 * 3 は organize.spec.ts が押さえているが、1 と 2 には自動テストが無かった。
 * どちらも落ちても画面は動くように見え、古い著者が新しい作品名に付く形で
 * しか表に出ない。出来る本の名前がそのまま変わるので、気づかれないまま
 * 蔵書に混ざる。
 *
 * 応答の前後は page.route で作る。問い合わせを保留したまま打ち替え、返す順を
 * こちらで決める。偶然そうなる回を待つのではなく、「後から届く」ことを台本に
 * する（cover-stale.spec.ts と同じ作り）。
 */

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => sidecar?.stop());

/** 打つたびに問い合わせないための待ち時間。useAuthorLookup と同じ値 */
const SEARCH_DELAY_MS = 400;

/** 応答が届いた後、描き直しを待つ幅。届いた直後は前の絵を見てしまう */
const SETTLE_MS = 500;

/** 問い合わせが飛ぶ・届くのを待つ上限 */
const WAIT_MS = 10_000;

/** 検索で引く相手。作品名と、返ってくる著者たち（先頭が採用される） */
type Subject = {
  readonly title: string;
  readonly authors: readonly [string, string];
};

/**
 * 打ち替える前と後。
 *
 * 作品名も著者も候補も、前後で 1 文字も重ねない。重ねると、古い応答が
 * そのまま画面に残っていても assert が通ってしまう。
 */
const FIRST: Subject = {
  title: "打ち替える前の作品",
  authors: ["前の著者", "前の相棒"],
} as const;

const SECOND: Subject = {
  title: "打ち替えた後の作品",
  authors: ["後の著者", "後の相棒"],
} as const;

/** 素早く打ち替える 3 つ。最後の 1 つだけが問い合わせられるはず */
const RAPID: readonly Subject[] = [
  { title: "早打ちの一つ目", authors: ["一つ目の著者", "一つ目の相棒"] },
  { title: "早打ちの二つ目", authors: ["二つ目の著者", "二つ目の相棒"] },
  { title: "早打ちの三つ目", authors: ["三つ目の著者", "三つ目の相棒"] },
] as const;

/** 素早い打ち替えのうち、最後の 1 つ */
const RAPID_LAST = RAPID[RAPID.length - 1]!;

/** `POST /api/library/suggest` の応答。Suggestion の形をそのまま埋める */
function suggestion(subject: Subject) {
  return {
    title: subject.title,
    author: subject.authors[0],
    candidates: subject.authors.map((author, index) => ({
      title: subject.title,
      author,
      source: "AniList",
      similarity: 1 - index * 0.1,
    })),
  };
}

/** 差し替えた応答。オリジンが違うので、素通しできるよう明示する */
function asJson(payload: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(payload),
  };
}

/** 問い合わせに載った作品名。作品名は URL ではなく本文に入る */
function askedTitle(body: string | null): string {
  if (!body) return "";
  return (JSON.parse(body) as { title?: string }).title ?? "";
}

type SuggestControl = {
  /** 問い合わせに載った作品名。飛んだ順 */
  asked: string[];
  /** 応答が画面へ届いた作品名。届いた順 */
  arrived: string[];
  /** その作品名の応答を返す。まだ飛んでいなければ、飛ぶまで待つ */
  reply: (subject: Subject) => Promise<void>;
};

/**
 * 著者検索を保留できるようにする。
 *
 * 返す順をこちらで決めたいので、応答は投げっぱなしにせず握っておく。
 * 届いた記録は response イベントで取る。送り出した順で取ると、前後が
 * 本当に起きたのかを取り違える。
 */
async function holdSuggest(page: Page): Promise<SuggestControl> {
  const asked: string[] = [];
  const arrived: string[] = [];
  const held = new Map<string, (subject: Subject) => void>();

  page.on("response", (response) => {
    const request = response.request();
    if (!new URL(response.url()).pathname.endsWith("/api/library/suggest")) {
      return;
    }
    if (request.method() !== "POST") return;
    arrived.push(askedTitle(request.postData()));
  });

  await page.route("**/api/library/suggest*", async (route) => {
    const request = route.request();
    // CORS の下見（OPTIONS）は問い合わせではない。数えず素通しする
    if (request.method() !== "POST") return route.continue();
    asked.push(askedTitle(request.postData()));
    const subject = await new Promise<Subject>((resolve) => {
      held.set(askedTitle(request.postData()), resolve);
    });
    await route.fulfill(asJson(suggestion(subject)));
  });

  const reply = async (subject: Subject) => {
    await expect
      .poll(() => held.has(subject.title), {
        message: `${subject.title} の問い合わせが飛んでいない`,
        timeout: WAIT_MS,
      })
      .toBe(true);
    const release = held.get(subject.title)!;
    held.delete(subject.title);
    release(subject);
  };

  return { asked, arrived, reply };
}

/** 問い合わせが、この作品名だけがこの順に飛ぶまで待つ */
async function waitForAsked(control: SuggestControl, titles: string[]) {
  await expect
    .poll(() => control.asked, {
      message: `問い合わせが ${titles.join(" → ")} の順に飛んでいない`,
      timeout: WAIT_MS,
    })
    .toEqual(titles);
}

/** 応答が、この作品名だけがこの順に届くまで待つ */
async function waitForArrived(control: SuggestControl, titles: string[]) {
  await expect
    .poll(() => control.arrived, {
      message: `応答が ${titles.join(" → ")} の順に届いていない`,
      timeout: WAIT_MS,
    })
    .toEqual(titles);
}

/** 著者を名指しした候補。件数ではなく中身で照合するため */
function candidateOf(page: Page, author: string): Locator {
  return page.locator(
    `[data-testid="author-candidate"][data-author="${author}"]`,
  );
}

async function openOrganize(page: Page, name: string) {
  const output = join(sidecar.workDir, `out-${name}`);
  mkdirSync(output, { recursive: true });
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await expect(page.getByTestId("mode-organize")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("organize-title")).toHaveValue("");
}

/**
 * 問い合わせを保留したまま打ち替え、2 つの問い合わせが宙に浮いた状態を作る。
 *
 * 打ち替えは、前の作品名が**飛んだことを確かめてから**行う。飛ぶ前に
 * 打ち替えると間引かれて 1 本しか飛ばず、前後を試したことにならない。
 */
async function askTwice(page: Page, control: SuggestControl) {
  await page.getByTestId("organize-title").fill(FIRST.title);
  await waitForAsked(control, [FIRST.title]);
  await page.getByTestId("organize-title").fill(SECOND.title);
  await waitForAsked(control, [FIRST.title, SECOND.title]);
}

test.describe("著者検索: 応答の前後と打ち替えの間引き", () => {
  test("古い応答が後から届いても、著者と候補は打ち替えた後のものだけになる", async ({
    page,
  }) => {
    // Arrange - 2 つの問い合わせを保留したまま宙に浮かせる
    const control = await holdSuggest(page);
    await openOrganize(page, "入れ替え");
    await askTwice(page, control);

    // Act - 後の応答を先に返し、画面に載ったのを見てから前の応答を返す
    await control.reply(SECOND);
    await expect(page.getByTestId("organize-author")).toHaveValue(
      SECOND.authors[0],
    );
    await control.reply(FIRST);

    // 制御 - 応答の前後が本当に起きている。ここが揃わないと、以降の検証は
    // 「古い応答が届いていないだけ」の状態を見ていることになる
    await waitForArrived(control, [SECOND.title, FIRST.title]);
    // 届いた直後は、まだ描き直されていないだけの状態を見てしまう
    await page.waitForTimeout(SETTLE_MS);

    // Assert - 著者は打ち替えた後のもの。結果の反映側から世代の判定
    // （seq !== searchSeq.current）を外すと、ここが「前の著者」に化けて落ちる
    await expect(
      page.getByTestId("organize-author"),
      "古い応答の著者で上書きされている",
    ).toHaveValue(SECOND.authors[0]);

    // Assert - 候補も後のものだけ。件数は同一性の代わりにならないので、
    // 出ている方も消えている方も著者名で名指しする
    for (const author of SECOND.authors) {
      await expect(
        candidateOf(page, author),
        `打ち替えた後の候補 ${author} が出ていない`,
      ).toBeVisible();
    }
    for (const author of FIRST.authors) {
      await expect(
        candidateOf(page, author),
        `古い応答の候補 ${author} が残っている`,
      ).toHaveCount(0);
    }
    await expect(
      page.getByTestId("author-candidate"),
      "打ち替えた後の候補に、古い応答の候補が混ざっている",
    ).toHaveCount(SECOND.authors.length);
  });

  test("古い応答では検索中の表示が終わらず、新しい応答で終わる", async ({
    page,
  }) => {
    // Arrange - 2 つの問い合わせを保留したまま宙に浮かせる
    const control = await holdSuggest(page);
    await openOrganize(page, "検索中");
    await askTwice(page, control);

    // 制御 - どちらも返していないので、検索中が出ている
    await expect(
      page.getByTestId("author-searching"),
      "問い合わせが飛んでいるのに検索中が出ていない",
    ).toBeVisible();

    // Act - 古い方（打ち替える前）の応答だけを返す
    await control.reply(FIRST);
    await waitForArrived(control, [FIRST.title]);
    await page.waitForTimeout(SETTLE_MS);

    // Assert - 新しい方はまだ返っていないので、検索中は出たまま。finally 側の
    // 世代の判定を外すと、ここで検索中が消えて落ちる。利用者から見ると、
    // 探している最中なのに「探し終わって著者が見つからなかった」に見える
    await expect(
      page.getByTestId("author-searching"),
      "古い応答で検索中の表示が終わっている",
    ).toBeVisible();
    await expect(
      page.getByTestId("organize-author"),
      "古い応答の著者が入っている",
    ).toHaveValue("");

    // Act / Assert - 新しい方が返れば検索中は消え、その著者が入る。
    // 検索中が消えない実装でも上の assert は通るので、対で確かめる
    await control.reply(SECOND);
    await expect(page.getByTestId("organize-author")).toHaveValue(
      SECOND.authors[0],
    );
    await expect(
      page.getByTestId("author-searching"),
      "応答が届いても検索中のままになっている",
    ).toBeHidden();
  });

  test("待ち時間の内に打ち替えると、途中の作品名は問い合わせられない", async ({
    page,
  }) => {
    // Arrange
    const control = await holdSuggest(page);
    await openOrganize(page, "早打ち");
    const titleInput = page.getByTestId("organize-title");

    // Act - 待ち時間より短い間隔で 3 回打ち替える
    const startedAt = Date.now();
    for (const subject of RAPID) await titleInput.fill(subject.title);
    const elapsed = Date.now() - startedAt;
    await expect(titleInput).toHaveValue(RAPID_LAST.title);

    // 制御 - 3 回の打ち替えが待ち時間に収まっている。ここを超えていたら、
    // 間引きではなく打ち替えが遅かっただけを見ていることになる
    expect(
      elapsed,
      "打ち替えが待ち時間より遅く、間引きを試したことにならない",
    ).toBeLessThan(SEARCH_DELAY_MS);

    // Act - 最後の 1 回が飛ぶまで待ち、さらに待ち時間 2 回分を見送る
    await waitForAsked(control, [RAPID_LAST.title]);
    await page.waitForTimeout(SEARCH_DELAY_MS * 2);

    // Assert - 飛んだのは最後の作品名だけ。回数だけを数えると「たまたま
    // 1 回しか飛ばなかった」でも通るので、載った作品名まで見る。
    // SEARCH_DELAY_MS を 0 にすると 3 つ並んでここで落ちる
    expect(
      control.asked,
      "間引かれず、途中の作品名まで問い合わせている",
    ).toEqual([RAPID_LAST.title]);

    // 制御 - 飛んだ 1 回は本当に効いている。返せば最後の作品名の著者が入る。
    // これが無いと「検索そのものが動いていない」でも上の assert が通る
    await control.reply(RAPID_LAST);
    await expect(
      page.getByTestId("organize-author"),
      "最後に打った作品名の著者が入らない",
    ).toHaveValue(RAPID_LAST.authors[0]);
    await expect(
      candidateOf(page, RAPID_LAST.authors[1]),
      "最後に打った作品名の候補が出ていない",
    ).toBeVisible();
  });
});
