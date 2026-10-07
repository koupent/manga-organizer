import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { derivedRecordsOf, runPython } from "./archive";
import { openCoverTools, saveCoverTools } from "./cover-tools";
import { startSidecar, type Sidecar } from "./sidecar";

let sidecar: Sidecar;
test.beforeAll(async () => {
  sidecar = await startSidecar();
});
test.afterAll(() => sidecar?.stop());

async function open(page: Page, name: string) {
  const archive = `${sidecar.workDir}/${name}.zip`;
  runPython(
    `
import io, sys, zipfile
from PIL import Image, ImageDraw
image = Image.new('RGB', (1200, 900), '#eeeeee')
draw = ImageDraw.Draw(image)
for y in range(0, 900, 30):
 for x in range(0, 1200, 30):
  draw.rectangle((x, y, x+29, y+29), fill=((x//30)*6, (y//30)*8, 128), outline='black')
data = io.BytesIO()
image.save(data, 'PNG')
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 z.writestr('001.png', data.getvalue())
`,
    archive,
  );
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(
    `/?${new URLSearchParams({ api: sidecar.baseUrl, token: sidecar.token, mode: "thumbnail", archive })}`,
  );
  await openCoverTools(page);
  await expect(page.getByTestId("crop-frame")).toBeVisible();
  return archive;
}

const handleOf = (page: Page, edge: string) =>
  page.getByTestId(edge === "se" ? "crop-handle" : `crop-handle-${edge}`);
const frameOf = async (page: Page) =>
  (await page.getByTestId("crop-frame").boundingBox())!;
async function resize(page: Page, edge: string, dx: number, dy: number) {
  const box = (await handleOf(page, edge).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("crop-loupe")).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + dx,
    box.y + box.height / 2 + dy,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(page.getByTestId("crop-loupe")).toBeHidden();
}

test("4辺・4角を独立して調整でき、反対の辺と枠の移動は変わらない", async ({
  page,
}) => {
  const archive = await open(page, "全辺を調整");
  const before = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  for (const edge of ["n", "s", "w", "e", "nw", "ne", "sw", "se"]) {
    await page.getByTestId("crop-reset").click();
    const start = await frameOf(page);
    const dx = edge.includes("w") ? 18 : edge.includes("e") ? -18 : 0;
    const dy = edge.includes("n") ? 18 : edge.includes("s") ? -18 : 0;
    await resize(page, edge, dx, dy);
    const end = await frameOf(page);
    const expected = {
      x: start.x + (edge.includes("w") ? dx : 0),
      y: start.y + (edge.includes("n") ? dy : 0),
      width: start.width + (edge.includes("w") ? -dx : dx),
      height: start.height + (edge.includes("n") ? -dy : dy),
    };
    for (const key of ["x", "y", "width", "height"] as const)
      expect(
        Math.abs(end[key] - expected[key]),
        `${edge}: ${key}`,
      ).toBeLessThan(1);
  }
  const start = await frameOf(page);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    start.x + start.width / 2 + 12,
    start.y + start.height / 2 + 12,
  );
  await expect(page.getByTestId("crop-loupe")).toBeHidden();
  await page.mouse.up();
  const end = await frameOf(page);
  expect(end.width).toBeCloseTo(start.width, 0);
  expect(end.height).toBeCloseTo(start.height, 0);
  expect(end.x - start.x).toBeCloseTo(12, 0);
  expect(end.y - start.y).toBeCloseTo(12, 0);
  expect(createHash("sha256").update(readFileSync(archive)).digest("hex")).toBe(
    before,
  );
});

test("拡大表示はカーソル位置を2倍で映し、回転後も向きが揃う", async ({
  page,
}) => {
  await open(page, "調整箇所の拡大");
  for (const angle of [0, 90]) {
    if (angle) await page.getByTestId("rotate").click();
    await handleOf(page, "w").hover();
    const loupe = page.getByTestId("crop-loupe");
    await expect(loupe).toBeVisible();
    await expect
      .poll(() =>
        loupe
          .locator("svg")
          .evaluate((svg: SVGSVGElement) => svg.getScreenCTM()!.a),
      )
      .toBeCloseTo(2, 2);
    await expect(loupe.locator("image")).toHaveAttribute(
      "transform",
      new RegExp(`rotate\\(${angle} `),
    );
    const handle = (await handleOf(page, "w").boundingBox())!;
    const lens = (await loupe.boundingBox())!;
    expect(handle.x < lens.x || handle.x > lens.x + lens.width).toBe(true);
    await page
      .getByTestId("cover-canvas")
      .screenshot({ path: resolve(`.sandbox/crop-loupe-${angle}.png`) });
    await page.mouse.move(5, 5);
    await expect(loupe).toBeHidden();
  }
});

test("左辺・上辺から調整した範囲を保存し、開き直して復元する", async ({
  page,
}) => {
  const archive = await open(page, "左上から切り取り");
  const stage = (await page.getByTestId("cover-image").boundingBox())!;
  await resize(page, "w", 30, 0);
  await resize(page, "n", 0, 25);
  const frame = await frameOf(page);
  const expected = [
    Math.round(((frame.x - stage.x) * 1200) / stage.width),
    Math.round(((frame.y - stage.y) * 900) / stage.height),
    Math.round(((frame.x + frame.width - stage.x) * 1200) / stage.width),
    Math.round(((frame.y + frame.height - stage.y) * 900) / stage.height),
  ];
  await saveCoverTools(page);
  const operations = Object.values(derivedRecordsOf(archive))[0].operations;
  const saved = operations.find((operation) => operation.kind === "crop")!
    .params.box as number[];
  saved.forEach((value, index) =>
    expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(2),
  );
  const restored = await frameOf(page);
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(restored[key] - frame[key])).toBeLessThan(2);
});
