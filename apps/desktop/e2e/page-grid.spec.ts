import { expect, test } from "@playwright/test";
import {
  rowsOf,
  spreadAlignedColumns,
  spreadPairs,
  type GridCell,
} from "../src/lib/page-grid";

/**
 * ページ一覧の列数を、見開きに合わせて選ぶ計算を検証する。
 *
 * ブラウザを開かない検証だが、この app に用意されている実行系は Playwright
 * だけなので e2e/ に置く。中で page を使わないので、ブラウザは起動しない。
 */

const PAGE: GridCell = { span: 1, pairable: true };
const SPREAD: GridCell = { span: 2, pairable: true };
const DELETED: GridCell = { span: 1, pairable: false };

const pages = (count: number) => Array<GridCell>(count).fill(PAGE);

function splitPairs(cells: GridCell[], columns: number) {
  const rows = rowsOf(cells, columns);
  return spreadPairs(cells).filter(([a, b]) => rows[a] !== rows[b]);
}

test("見開きの後ろは直後から、前は見開きから遡って 2 枚ずつ組む", () => {
  const cells = [...pages(3), SPREAD, ...pages(5), SPREAD, PAGE];

  expect(spreadPairs(cells)).toEqual([
    [1, 2],
    [4, 5],
    [6, 7],
  ]);
});

test("割って保存した見開きは、半分の 2 枚を 1 組とし基準にする", () => {
  const cells = [
    ...pages(2),
    { ...PAGE, half: 0 } as const,
    { ...PAGE, half: 1 } as const,
    ...pages(4),
  ];

  expect(spreadPairs(cells)).toEqual([
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
  ]);
  expect(splitPairs(cells, 5)).not.toEqual([]);
  expect(spreadAlignedColumns(cells, 5)).toBe(4);
});

test("削除したページは場所だけ取り、組に入らない", () => {
  const cells = [SPREAD, PAGE, DELETED, PAGE, PAGE];

  expect(spreadPairs(cells)).toEqual([[1, 3]]);
});

test("見開きは行末に入らなければ次の行の先頭へ回る", () => {
  expect(rowsOf([...pages(3), SPREAD, PAGE], 4)).toEqual([0, 0, 0, 1, 1]);
  expect(rowsOf([...pages(3), SPREAD, PAGE], 5)).toEqual([0, 0, 0, 0, 1]);
});

test("見開きの無い本は表示サイズどおりの列数のまま", () => {
  expect(spreadAlignedColumns(pages(30), 7)).toBe(7);
});

test("組が行をまたがない列数があれば、表示サイズの列数をそのまま使う", () => {
  const cells = [...pages(3), SPREAD, ...pages(12)];

  expect(splitPairs(cells, 4)).toEqual([]);
  expect(spreadAlignedColumns(cells, 4)).toBe(4);
});

test("表示サイズの列数で組が分かれるなら、分かれない列数まで減らす", () => {
  const cells = [...pages(3), SPREAD, ...pages(12)];

  expect(splitPairs(cells, 5)).not.toEqual([]);
  expect(spreadAlignedColumns(cells, 5)).toBe(4);
});

test("見開きが奇数列から始まるなら、見開きを次の行へ回せる列数まで減らす", () => {
  const cells = [...pages(3), SPREAD, ...pages(14)];

  expect(spreadAlignedColumns(cells, 7)).toBe(4);
});

test("減らせるのは半分まで。揃わなければ分かれる組が最も少ない列数", () => {
  const cells = [...pages(3), SPREAD, ...pages(14)];
  const chosen = spreadAlignedColumns(cells, 9);

  expect(chosen).toBeGreaterThanOrEqual(5);
  for (const columns of [5, 6, 7, 8, 9])
    expect(splitPairs(cells, chosen).length).toBeLessThanOrEqual(
      splitPairs(cells, columns).length,
    );
});

test("1 列しか入らない幅では列数を変えない", () => {
  expect(spreadAlignedColumns([PAGE, SPREAD, PAGE, PAGE], 1)).toBe(1);
});
