import { expect, test } from "@playwright/test";
import { placePages } from "../src/lib/page-grid";

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
