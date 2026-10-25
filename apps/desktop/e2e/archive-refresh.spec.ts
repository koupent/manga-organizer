import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startSidecar, writeArchive, type Sidecar } from "./sidecar";

/**
 * 画面がディスクを読み直すこと。
 *
 * 1. 目次を読めない RAR は解析の途中で ZIP に置き換わる。画面が投入した
 *    RAR のパスのままだと、本は ZIP 側に付いていて一覧に出ない。置き換えを
 *    受け取ったら、そのパスで出来上がる本を出す。
 * 2. 出力先のフォルダでファイルを消す・足すと、再読み込みを押さなくても
 *    一覧が追従する。
 */

let sidecar: Sidecar;

test.beforeAll(async () => {
  sidecar = await startSidecar();
});

test.afterAll(() => sidecar?.stop());

const AUTHOR = "監視の著者";
const TITLE = "監視の作品";

function asJson(status: number, payload: unknown) {
  return {
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(payload),
  };
}

test("読めない RAR を入れると、ZIP へ置き換わったパスの本が出て RAR のまま残らない", async ({
  page,
}) => {
  const rarName = "読めない_04.rar";
  const rar = join(sidecar.workDir, rarName);
  writeFileSync(rar, "not-a-real-rar");
  const zip = rar.replace(/\.rar$/i, ".zip");
  const submitted: string[] = [];

  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill(asJson(200, { author: null, candidates: [] })),
  );
  await page.route("**/api/jobs/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/api/jobs/analyze") && request.method() === "POST") {
      submitted.push("analyze");
      return route.fulfill(asJson(202, { id: "refresh-job" }));
    }
    if (path.endsWith("/cancel")) {
      return route.fulfill(asJson(202, { id: "refresh-job" }));
    }
    if (!path.endsWith("/refresh-job")) return route.continue();
    return route.fulfill(
      asJson(200, {
        id: "refresh-job",
        kind: "analyze",
        state: "succeeded",
        current: 1,
        total: 1,
        message: "",
        result: {
          scanned: true,
          containers: [zip],
          books: [
            {
              source: zip,
              entry: "",
              output_name: `[${AUTHOR}] ${TITLE} 第004巻.zip`,
              volume: 4,
              issues: [],
              organized: false,
              organized_reason: "name-mismatch",
              author: null,
              title: null,
            },
          ],
          unreadable: [],
          replacements: [{ before: rar, after: zip }],
          reading: 0,
        },
        error: null,
        created_at: "2026-01-01T00:00:00+00:00",
        updated_at: "2026-01-01T00:00:01+00:00",
        log: [],
      }),
    );
  });

  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(sidecar.workDir)}`,
  );
  await page.getByTestId("organize-title").fill(TITLE);
  await page.getByTestId("organize-author").fill(AUTHOR);
  await page.getByTestId("open-browser").click();
  await page
    .locator(
      `[data-testid="browse-entry"][data-name="${rarName}"] .browser-name`,
    )
    .click();
  await page.getByTestId("open-browser").click();

  // Assert - 左の投入も右の本も、置き換わった ZIP を指す。RAR の行は残らない
  await expect(page.getByTestId("source-row")).toHaveAttribute(
    "data-path",
    zip,
  );
  const book = page.locator('[data-testid="plan-row"][data-kind="book"]');
  await expect(book).toHaveCount(1);
  await expect(book).toHaveAttribute("data-source", zip);
  await expect(book).toHaveAttribute(
    "data-output-name",
    `[${AUTHOR}] ${TITLE} 第004巻.zip`,
  );
  await expect(
    page.locator(`[data-testid="plan-row"][data-path="${rar}"]`),
  ).toHaveCount(0);
  // 置き換えで解析をやり直すと、変換済みの結果を捨てて RAR から読み直す
  await expect.poll(() => submitted.length, { timeout: 1500 }).toBe(1);
});

test("出力先のフォルダで消した本は一覧から外れ、足した本は入る", async ({
  page,
}) => {
  const output = join(sidecar.workDir, "out-watch");
  const series = `[${AUTHOR}] ${TITLE}`;
  const folder = join(output, series);
  mkdirSync(folder, { recursive: true });
  const kept = writeArchive(
    sidecar.workDir,
    join("out-watch", series, `${series} 第003巻.zip`),
    [{ name: "001.jpg", color: "#aa0000" }],
  );
  const removed = writeArchive(
    sidecar.workDir,
    join("out-watch", series, `${series} 第004巻.zip`),
    [{ name: "001.jpg", color: "#00aa00" }],
  );
  writeArchive(sidecar.workDir, "投入_01.zip", [
    { name: "001.jpg", color: "#0000aa" },
  ]);

  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill(asJson(200, { author: null, candidates: [] })),
  );
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(output)}`,
  );
  await page.getByTestId("organize-title").fill(TITLE);
  await page.getByTestId("organize-author").fill(AUTHOR);
  await page.getByTestId("open-browser").click();
  await page
    .locator(
      '[data-testid="browse-entry"][data-name="投入_01.zip"] .browser-name',
    )
    .click();
  await page.getByTestId("open-browser").click();

  const existing = page.locator('[data-testid="plan-row"][data-existing]');
  await expect(existing).toHaveCount(2);
  await expect(
    page.locator(`[data-testid="plan-row"][data-source="${removed}"]`),
  ).toHaveCount(1);

  unlinkSync(removed);

  await expect(existing).toHaveCount(1, { timeout: 8000 });
  await expect(
    page.locator(`[data-testid="plan-row"][data-source="${removed}"]`),
  ).toHaveCount(0);
  await expect(
    page.locator(`[data-testid="plan-row"][data-source="${kept}"]`),
  ).toHaveCount(1);

  const added = writeArchive(
    sidecar.workDir,
    join("out-watch", series, `${series} 第005巻.zip`),
    [{ name: "001.jpg", color: "#aaaa00" }],
  );
  await expect(
    page.locator(`[data-testid="plan-row"][data-source="${added}"]`),
  ).toHaveCount(1, { timeout: 8000 });
  await expect(existing).toHaveCount(2);
});
