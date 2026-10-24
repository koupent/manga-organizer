import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { runPython } from "./archive";
import { startSidecar, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

/** 表紙と単ページ 4 枚、見開き、単ページ 5 枚、見開き、単ページ 12 枚 */
const SPREADS = new Set([6, 12]);
const PAGE_COUNT = 24;
const GRID_GAP = 12;

/** 見開きを基準に組む 2 枚。表紙側は見開きから遡って組む */
const PAIRS = [
  [2, 3],
  [4, 5],
  [7, 8],
  [9, 10],
  [13, 14],
  [15, 16],
  [17, 18],
  [19, 20],
  [21, 22],
  [23, 24],
];

const nameOf = (page: number) => `${String(page).padStart(3, "0")}.png`;

function writeBook(name: string) {
  const archive = join(sidecar.workDir, name);
  runPython(
    `import io, sys, zipfile
from PIL import Image
spreads = {${[...SPREADS].join(", ")}}
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for page in range(1, ${PAGE_COUNT + 1}):
        size = (1200, 900) if page in spreads else (600, 900)
        image = Image.new('RGB', size, ((page * 53) % 256, (page * 97) % 256, (page * 151) % 256))
        b = io.BytesIO(); image.save(b, 'PNG'); z.writestr(f'{page:03d}.png', b.getvalue())`,
    archive,
  );
  return archive;
}

/** 窓を狭い幅から広い幅へ、最後に少し戻して変える */
const WIDTHS = [640, 900, 1100, 1400, 1800, 1000];

async function expectAligned(page: Page) {
  const grid = await page.getByTestId("page-grid").evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
    };
  });
  const boxes = new Map(
    await page.getByTestId("editable-page").evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return [
          element.getAttribute("data-name") ?? "",
          { left: box.left, right: box.right, top: box.top },
        ] as const;
      }),
    ),
  );
  const box = (page: number) => boxes.get(nameOf(page))!;
  const slotWidth = box(1).right - box(1).left + GRID_GAP;
  const columns = Math.floor((grid.right - grid.left + GRID_GAP) / slotWidth);
  // 窓を変えた直後の古い並びを見ないよう、列数が今の幅に追いつくのを待つ
  expect(grid.columns).toBe(columns);

  for (const [first, second] of PAIRS) {
    expect(box(first).top, `${first}-${second}`).toBe(box(second).top);
  }
  // 1 行目に表紙・2 組・見開きの 7 枠が入るなら、見開きを次の行へ回さない
  if (columns >= 7) expect(box(6).top).toBe(box(1).top);

  const rows = new Map<number, { left: number; right: number }>();
  for (const { left, right, top } of boxes.values()) {
    const row = rows.get(top);
    rows.set(top, {
      left: Math.min(left, row?.left ?? left),
      right: Math.max(right, row?.right ?? right),
    });
  }
  const tops = [...rows.keys()].sort((a, b) => a - b);
  for (const top of tops.slice(0, -1)) {
    const row = rows.get(top)!;
    expect(Math.abs(row.right - grid.right)).toBeLessThan(2);
    // 空くのは、入りきらない端数と行末の 1 枠まで
    expect(row.left - grid.left).toBeLessThan(slotWidth * 2);
  }
}

test("結合モードの右から左は、窓の幅を変えても組を分けず、見開きは入るなら同じ行に置く", async ({
  page,
}) => {
  const archive = writeBook("merge-layout.zip");
  await page.setViewportSize({ width: WIDTHS[0], height: 900 });
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "edit", archive })}`,
  );
  await page.getByTestId("split-step-merge").click();
  await page.getByTestId("page-direction").check();
  await expect(page.getByTestId("editable-page")).toHaveCount(PAGE_COUNT);

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(() => expectAligned(page)).toPass();
    await page.screenshot({
      path: test.info().outputPath(`merge-layout-${width}.png`),
    });
  }
});
