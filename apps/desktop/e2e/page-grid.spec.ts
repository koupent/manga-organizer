import { expect, test } from "@playwright/test";
import {
  pageGroups,
  placePages,
  type GridCell,
  type PageSlot,
} from "../src/lib/page-grid";

/**
 * ページ一覧の置き場所を検証する。
 *
 * ブラウザを開かない検証だが、この app に用意されている実行系は Playwright
 * だけなので e2e/ に置く。中で page を使わないので、ブラウザは起動しない。
 */

const PAGE: GridCell = { span: 1 };
const SPREAD: GridCell = { span: 2 };
const pages = (count: number) => Array<GridCell>(count).fill(PAGE);

/** 表紙、奇数枚の単ページ、見開き、単ページ、見開き、単ページの本 */
const BOOK = [...pages(5), SPREAD, ...pages(5), SPREAD, ...pages(12)];

const rowWidth = (slots: PageSlot[], row: number) =>
  slots
    .filter((slot) => slot.row === row)
    .reduce((sum, slot) => sum + slot.span, 0);

test("見開きの前は見開きから遡り、後ろは直後から 2 枚ずつ組む", () => {
  expect(pageGroups([...pages(5), SPREAD, ...pages(3), SPREAD])).toEqual([
    [0],
    [1, 2],
    [3, 4],
    [5],
    [6, 7],
    [8],
    [9],
  ]);
});

test("割って保存した見開きは、半分の 2 枚を 1 組とし基準にする", () => {
  const cells: GridCell[] = [
    ...pages(3),
    { span: 1, half: 0 },
    { span: 1, half: 1 },
    ...pages(2),
  ];
  expect(pageGroups(cells)).toEqual([[0], [1, 2], [3, 4], [5, 6]]);
});

test("見開きの無い本は組まず、入る列数まで詰める", () => {
  const slots = placePages(pages(7), 3, false);
  expect(slots.map((slot) => slot.row)).toEqual([1, 1, 1, 2, 2, 2, 3]);
});

test("見開きは、今の行に入るなら次の行へ回さない", () => {
  // 9 列なら 1 行目に表紙・2 組・見開き・1 組がちょうど入る
  const slots = placePages(BOOK, 9, true);
  expect(slots.slice(0, 8).every((slot) => slot.row === 1)).toBe(true);
  expect(rowWidth(slots, 1)).toBe(9);
});

test("右から左はどの行も右端から詰める", () => {
  const slots = placePages([PAGE, PAGE, PAGE, SPREAD, PAGE], 4, true);
  expect(slots).toEqual([
    { column: 4, row: 1, span: 1 },
    { column: 3, row: 1, span: 1 },
    { column: 2, row: 1, span: 1 },
    { column: 3, row: 2, span: 2 },
    { column: 2, row: 2, span: 1 },
  ]);
});

for (const columns of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
  test(`${columns} 列でも組は行をまたがず、空くのは行末の 1 枠まで`, () => {
    const slots = placePages(BOOK, columns, true);
    for (const group of pageGroups(BOOK)) {
      expect(new Set(group.map((index) => slots[index].row)).size).toBe(1);
    }
    const lastRow = slots[slots.length - 1].row;
    for (let row = 1; row < lastRow; row += 1) {
      expect(rowWidth(slots, row)).toBeGreaterThanOrEqual(columns - 1);
      expect(rowWidth(slots, row)).toBeLessThanOrEqual(columns);
    }
  });
}

test("1 列のときは見開きも組も 1 枚ずつ縦に並べる", () => {
  expect(placePages([SPREAD, PAGE, PAGE], 1, true)).toEqual([
    { column: 1, row: 1, span: 1 },
    { column: 1, row: 2, span: 1 },
    { column: 1, row: 3, span: 1 },
  ]);
});
