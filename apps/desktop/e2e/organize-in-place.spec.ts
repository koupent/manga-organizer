import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startSidecar, type Sidecar } from "./sidecar";

/**
 * 名前と置き場所は出来上がりなのに中身が違う本を、整理すると直ること（#127）。
 *
 * 蔵書のフォルダを入れると、その中の本の行き先は本自身になる。そこで飛ばす
 * 実装では、利用者が選んで整理しても何も変わらず、終わった後も
 * 「ページの連番が違います」が出続ける。
 *
 * サイドカー側の契約は `services/core/tests/test_organized_naming.py` の
 * `SelfDestinationRebuildTest`。ここは画面が作り直した後の姿を見せることを見る。
 */

const CORE_DIR = fileURLToPath(
  new URL("../../../services/core", import.meta.url),
);

const AUTHOR = "棚の著者";
const TITLE = "棚の作品";
const SERIES = `[${AUTHOR}] ${TITLE}`;
const BOOK = `${SERIES} 第003巻.zip`;
const LIBRARY_NAME = "蔵書";

/** 番号が 1 つ抜けた本（001, 002, 004）。名前と置き場所は整理の形 */
const FIXTURE_SCRIPT = `
import io
import sys
import zipfile
from pathlib import Path

from PIL import Image

target = Path(sys.argv[1])
target.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target, "w") as archive:
    for name in ("001.jpg", "002.jpg", "004.jpg"):
        buffer = io.BytesIO()
        Image.new("RGB", (60, 90), "navy").save(buffer, "JPEG")
        archive.writestr(name, buffer.getvalue())
`;

let sidecar: Sidecar;
let library: string;
let book: string;

test.beforeAll(async () => {
  sidecar = await startSidecar();
  library = join(sidecar.workDir, LIBRARY_NAME);
  book = join(library, SERIES, BOOK);
  const scriptPath = join(sidecar.workDir, "make_gapped_book.py");
  writeFileSync(scriptPath, FIXTURE_SCRIPT);
  execFileSync("uv", ["run", "python", scriptPath, book], { cwd: CORE_DIR });
  mkdirSync(library, { recursive: true });
});

test.afterAll(() => sidecar?.stop());

async function openOrganize(page: Page) {
  await page.goto(
    `/?api=${encodeURIComponent(sidecar.baseUrl)}&token=${sidecar.token}` +
      `&mode=organize&output=${encodeURIComponent(library)}`,
  );
  await page.route("**/api/library/suggest*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ author: null, candidates: [] }),
    }),
  );
}

test("行き先が自分自身の本は、整理するとその場で直り、一覧も整理済みになる", async ({
  page,
}) => {
  // Arrange - 蔵書を丸ごと入れる。出力先は蔵書なので、本の行き先は本自身
  await openOrganize(page);
  await page.getByTestId("organize-title").fill(TITLE);
  await page.getByTestId("organize-author").fill(AUTHOR);
  await page.getByTestId("open-browser").click();
  await page
    .locator(`[data-testid="browse-entry"][data-name="${LIBRARY_NAME}"]`)
    .getByRole("button", { name: "フォルダごと追加" })
    .click();
  await page.getByTestId("open-browser").click();

  const row = page.locator(
    `[data-testid="plan-row"][data-kind="book"][data-source="${book}"]`,
  );
  await expect(row).toHaveAttribute("data-organized-reason", "pages-mismatch", {
    timeout: 60_000,
  });

  // Act
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("organize-status")).toContainText(
    "整理しました",
    { timeout: 60_000 },
  );

  // Assert - 解析し直され、同じ本が整理済みとして並ぶ
  await expect(row, "作り直した本が整理済みにならない").toHaveAttribute(
    "data-organized",
    "true",
    { timeout: 60_000 },
  );
  await expect(row.getByTestId("plan-row-reason")).toHaveCount(0);
});
