import { openCoverTools, saveCoverTools } from "./cover-tools";
import { expect, test, type Page } from "@playwright/test";
import { VIEWER_CONTRACT_IMPORT, pageSizesOf, runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 選び直しの応答が前後して届いても、見ている 1 枚と確定する 1 枚がずれない
 * ことを確かめる（#66 画面側）。
 *
 * サムネイル作成画面は、選んだ 1 枚の状態を /api/cover に問い合わせる。
 * 続けて選び直すと問い合わせも 2 つ走り、返ってくる順は保証されない。
 * 遅い方が後から届いたとき、その応答をそのまま採ると、画面は選び直す前の
 * 1 枚に戻る。ここで確定を押すと、利用者が選んでいない 1 枚が切り抜かれ、
 * 元の絵は失われる。取り返しが付かない。
 *
 * 遅れは page.route で作る。ページの数や大きさで偶然起きるのを待つのではなく、
 * 「後から届く」ことをこちらで決めて再現する。
 */
let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 1 枚目・2 枚目・3 枚目。寸法も色も変えて、どれを見ているか中身から分かる */
const PAGES = [
  { name: "page-a.jpg", size: [900, 900], color: "#ff0000" },
  { name: "page-b.jpg", size: [800, 1000], color: "#00ff00" },
  { name: "page-c.jpg", size: [700, 1100], color: "#0000ff" },
] as const;

/** 遅らせる 1 枚（先に選ぶ方）と、その後に選ぶ 1 枚 */
const FIRST_PICK = PAGES[1];
const SECOND_PICK = PAGES[2];

/** 応答を遅らせる時間。選び直しを終えるには十分な長さ */
const SLOW_RESPONSE_MS = 3_000;

function writePages(name: string): string {
  const target = `${sidecar.workDir}/${name}`;
  runPython(
    `
import io, json, sys, zipfile
from PIL import Image
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    for entry in json.loads(sys.argv[2]):
        buffer = io.BytesIO()
        Image.new("RGB", tuple(entry["size"]), entry["color"]).save(
            buffer, "JPEG", quality=90
        )
        archive.writestr(entry["name"], buffer.getvalue())
`,
    target,
    JSON.stringify(PAGES),
  );
  return target;
}

/**
 * ページの中身そのものの指紋。
 *
 * 確定すると先頭移動でエントリ名が振り直されるので、名前では追えない。
 * 中身のハッシュなら、名前が変わっても「その絵が無事か」を追える。
 */
function pageDigests(archive: string): Record<string, string> {
  const output = runPython(
    `
import hashlib, json, sys, zipfile
${VIEWER_CONTRACT_IMPORT}
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.dumps({
        name: hashlib.sha256(archive.read(name)).hexdigest()[:16]
        for name in sorted(archive.namelist()) if is_viewer_page(name)
    }))
`,
    archive,
  );
  return JSON.parse(output);
}

async function openCover(page: Page, archive: string) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=thumbnail&archive=${encodeURIComponent(archive)}`,
  );
  await openCoverTools(page);
  await expect(page.getByTestId("crop-frame")).toBeVisible();
}

/** /api/cover の問い合わせに写る、その時点で選ばれている 1 枚 */
function askedFor(url: string): string {
  return new URL(url).searchParams.get("name") ?? "";
}

/**
 * 指定した 1 枚ぶんの応答だけを遅らせ、届いた順を記録する。
 *
 * 記録は応答が画面へ届いた順（response イベント）で取る。送り出した順で
 * 取ると、遅れが本当に効いたのかを取り違える。
 */
async function delayCoverFor(page: Page, slow: string): Promise<string[]> {
  const arrived: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/api/cover") arrived.push(askedFor(response.url()));
  });
  await page.route(
    (url) => url.pathname === "/api/cover",
    async (route) => {
      if (askedFor(route.request().url()) === slow) {
        await new Promise((resolve) => setTimeout(resolve, SLOW_RESPONSE_MS));
      }
      await route.continue();
    },
  );
  return arrived;
}

/** 候補一覧から 1 枚選ぶ。応答は待たない。待つと前後が起こらない */
async function pickPage(page: Page, name: string) {
  await openCoverTools(page, name);
}

/**
 * 2 枚続けて選び、古い応答が後から届くところまで進める。
 *
 * 「後から届いた」ことをその場で確かめる。ここが揃わないと、以降の検証は
 * 前後が起きていないだけの状態を見ていることになる。
 */
async function raceTheSelections(page: Page, archive: string) {
  const arrived = await delayCoverFor(page, FIRST_PICK.name);
  await openCover(page, archive);
  await expect(page.getByTestId("cover-name")).toHaveText(PAGES[0].name);

  await pickPage(page, FIRST_PICK.name);
  await pickPage(page, SECOND_PICK.name);

  // 制御 - 先に選んだ 1 枚の応答が、後から選んだ 1 枚より後に届いている
  await expect
    .poll(() => arrived, {
      timeout: SLOW_RESPONSE_MS * 3,
      message: "応答の前後が起きていない。この検証が意味を持たない",
    })
    .toEqual([PAGES[0].name, SECOND_PICK.name, FIRST_PICK.name]);

  // 届いた直後は、まだ描き直されていないだけの状態を見てしまう。
  // 少し置いてから見る
  await page.waitForTimeout(1_000);
}

test.describe("サムネイル作成: 選び直しの応答が前後して届く", () => {
  test("古い応答が後から届いても、見ている 1 枚は選んだ 1 枚のまま", async ({
    page,
  }) => {
    // Arrange / Act
    const archive = writePages("応答の前後 表示.zip");
    await raceTheSelections(page, archive);

    // Assert - 画面は最後に選んだ 1 枚を映している
    await expect(
      page.getByTestId("cover-name"),
      "古い応答で、選んでいない 1 枚に戻っている",
    ).toHaveText(SECOND_PICK.name);
    await expect(page.getByTestId("cover-size")).toHaveText(
      `${SECOND_PICK.size[0]}×${SECOND_PICK.size[1]}`,
    );

    // Assert - しばらく見ていても入れ替わらない
    await page.waitForTimeout(500);
    await expect(page.getByTestId("cover-name")).toHaveText(SECOND_PICK.name);
  });

  test("古い応答が後から届いた後に確定しても、選んでいない 1 枚を書き換えない", async ({
    page,
  }) => {
    // Arrange - 加工前の中身を控える。名前は確定で振り直されるので中身で追う
    const archive = writePages("応答の前後 確定.zip");
    const before = pageDigests(archive);
    expect(Object.keys(before)).toEqual(PAGES.map((entry) => entry.name));

    // Arrange - 選び直しの応答を前後させる
    await raceTheSelections(page, archive);

    // Act - そのまま確定する
    await saveCoverTools(page);
    await expect(page.getByTestId("split-status")).toContainText("確認済み", {
      timeout: 30_000,
    });

    // Assert - 選び直した方（先に選んだ 1 枚）は 1 バイトも変わっていない。
    // 書き換えられていれば、その中身の指紋がページから消える
    const after = Object.values(pageDigests(archive));
    expect(after, "選び直したはずの 1 枚が書き換えられている").toContain(
      before[FIRST_PICK.name],
    );

    // Assert - 触っていない 1 枚も無事
    expect(after).toContain(before[PAGES[0].name]);

    // 制御 - 確定そのものは効いている。最後に選んだ 1 枚は書き換わっている。
    // これが残っていると「何も起きなかった」だけで上の 2 つが通ってしまう
    expect(
      after,
      "確定しても何も書き換わっていない。検証として成立しない",
    ).not.toContain(before[SECOND_PICK.name]);

    // Assert - 出来上がった表紙は、最後に選んだ 1 枚から作ったもの。既定の枠は
    // 画像の全体で、足りない側に余白を足して 2:3 にする（#146）。700×1100
    // なら左右に足した 733×1100、800×1000 なら上下に足した 800×1200 になる
    const sizes = pageSizesOf(archive);
    const cover = sizes[Object.keys(sizes).sort()[0]];
    expect(cover, "選んでいない 1 枚が表紙になっている").toEqual([733, 1100]);
  });
});
