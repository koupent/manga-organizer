import { expect, test } from "@playwright/test";
import { placePages, spreadAlignedColumns } from "../src/lib/page-grid";

/**
 * ページ一覧の置き場所を検証する。
 *
 * ブラウザを開かない検証だが、この app に用意されている実行系は Playwright
 * だけなので e2e/ に置く。中で page を使わないので、ブラウザは起動しない。
 */

test("左から右は行頭から置き、見開きが入りきらなければ次の行の先頭へ回す", () => {
  expect(placePages([1, 1, 1, 2, 1], 4, false)).toEqual([
    { column: 1, row: 1, span: 1 },
    { column: 2, row: 1, span: 1 },
    { column: 3, row: 1, span: 1 },
    { column: 1, row: 2, span: 2 },
    { column: 3, row: 2, span: 1 },
  ]);
});

test("右から左はどの行も右端から詰め、見開きは行の右へ回す", () => {
  expect(placePages([1, 1, 1, 2, 1], 3, true)).toEqual([
    { column: 3, row: 1, span: 1 },
    { column: 2, row: 1, span: 1 },
    { column: 1, row: 1, span: 1 },
    { column: 2, row: 2, span: 2 },
    { column: 1, row: 2, span: 1 },
  ]);
});

test("1 列のときは見開きも 1 列に収める", () => {
  expect(placePages([2, 1], 1, true)).toEqual([
    { column: 1, row: 1, span: 1 },
    { column: 1, row: 2, span: 1 },
  ]);
});

test("見開きの後ろの 2 枚が行をまたがない列数を、入る数に一番近いものから選ぶ", () => {
  // 右から読むと、幅が 2,1,2,1,2,2 のあと単ページが続く。
  // 11 列だと 7 と 8 が分かれる。10 列なら同じ行になる。
  const spans = [2, 1, 2, 1, 2, 2, 1, 1, 1, 1] as const;
  expect(spreadAlignedColumns(spans, 11)).toBe(10);
  expect(spreadAlignedColumns(spans, 10)).toBe(10);
});

test("見開きが無ければ入る列数のままにする", () => {
  expect(spreadAlignedColumns([1, 1, 1, 1, 1, 1], 8)).toBe(8);
});

test("割れない列数が無ければ入る列数のままにする", () => {
  // 見開きの前の 2 枚組は 2 列で割れ、後ろの 2 枚組は 3 列で割れる。
  const spans = [1, 1, 1, 2, 1, 1] as const;
  expect(spreadAlignedColumns(spans, 3)).toBe(3);
});
