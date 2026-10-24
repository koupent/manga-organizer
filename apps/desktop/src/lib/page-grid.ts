/**
 * ページ一覧の各カードを、どの列に置くか。
 *
 * カードの幅は表示サイズのままにする。列数だけ、検出済みの見開きを基準に
 * 組んだ 2 枚が行をまたがないよう、入る数に一番近いものから選ぶ。
 * 割れない列数が無ければ、入る数のままにする。
 *
 * 右から左のときは各行を右端から詰める。格子に direction: rtl を付けると、
 * 1 行目は右に寄るが 2 行目以降が左に残るため、列番号はここで決める。
 */

/** 1 枚の置き場所。column は 1 始まりで左端の列、row も 1 始まり */
export type PageSlot = {
  column: number;
  row: number;
  span: 1 | 2;
};

/**
 * spans の各要素を、columns 列の格子へ置く。fromRight なら右端から詰める。
 *
 * 列だけを指定して行を自動に任せると、右から置くとき 1 枚ずつ次の行へ
 * 落ちる。行もここで決める。
 */
export function placePages(
  spans: ReadonlyArray<1 | 2>,
  columns: number,
  fromRight: boolean,
): PageSlot[] {
  const width = Math.max(1, columns);
  let row = 1;
  let used = 0;
  return spans.map((wanted) => {
    const span: 1 | 2 = wanted === 2 && width >= 2 ? 2 : 1;
    if (used + span > width) {
      row += 1;
      used = 0;
    }
    const column = fromRight ? width - used - span + 1 : used + 1;
    used += span;
    return { column, row, span };
  });
}

/**
 * 見開き（幅 2）を基準に、単ページを 2 枚ずつ組む。
 *
 * 見開きの後ろは先頭から組む。1 枚余るときは次の見開きの直前に置く。
 * 最初の見開きより前は、見開きから遡って組む。見開きが無ければ組まない。
 */
export function spreadPairs(spans: ReadonlyArray<1 | 2>): [number, number][] {
  const pairs: [number, number][] = [];
  let pages: number[] = [];
  let anchored = false;
  const flush = () => {
    const start = anchored ? 0 : pages.length % 2;
    for (let at = start; at + 1 < pages.length; at += 2) {
      pairs.push([pages[at], pages[at + 1]]);
    }
    pages = [];
  };
  spans.forEach((span, index) => {
    if (span === 2) {
      flush();
      anchored = true;
    } else {
      pages.push(index);
    }
  });
  if (anchored) flush();
  return pairs;
}

/** 組の 2 枚が別の行に分かれた数。行の左右は割れ方に影響しない */
function splitCount(spans: ReadonlyArray<1 | 2>, columns: number): number {
  const slots = placePages(spans, columns, false);
  return spreadPairs(spans).filter(
    ([left, right]) => slots[left].row !== slots[right].row,
  ).length;
}

/**
 * 組が行をまたがない列数のうち、maxColumns に一番近いもの。
 *
 * 入る列数から 1 つずつ減らして探す。割れない列数が無ければ入る列数のまま。
 * 見開きが無ければ組が無いので、入る列数のまま。
 */
export function spreadAlignedColumns(
  spans: ReadonlyArray<1 | 2>,
  maxColumns: number,
): number {
  const limit = Math.max(1, maxColumns);
  if (limit < 2 || !spans.includes(2)) return limit;
  for (let columns = limit; columns >= 2; columns -= 1) {
    if (splitCount(spans, columns) === 0) return columns;
  }
  return limit;
}
