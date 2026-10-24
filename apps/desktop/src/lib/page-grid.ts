/**
 * ページ一覧の列数を、見開きに合わせて選ぶ。
 *
 * 人が見開きかどうかを目で確かめるとき、組になる 2 枚が行の末尾と次の行の
 * 先頭に分かれると見比べにくい。検出済みの見開き（2 列ぶんのカード）を基準に
 * 前後のページを 2 枚ずつ組み、組が同じ行に収まる列数を選ぶ。ページの順番は
 * 変えず、空のセルも挟まない。
 */

/** 格子に置く 1 枚 */
export type GridCell = {
  /** 2 は見開きのように 2 列ぶんを占める */
  span: 1 | 2;
  /** false のカード（削除済みのページなど）は場所だけ取り、組には入れない */
  pairable: boolean;
  /** 割って保存した見開きの半分。0 の直後に 1 が並ぶ。2 枚で 1 つの見開きとして扱う */
  half?: 0 | 1;
};

const isSpread = (cell: GridCell) => cell.span === 2 || cell.half === 0;

/**
 * 表示サイズが許す列数に対し、減らしてよい下限の割合。見開きが行の奇数列から
 * 始まる本は、見開きを次の行へ回せる列数まで減らさないと揃わないことがある。
 * 半分より減らすとカードが倍より大きくなるので、そこで止める
 */
const MIN_COLUMN_RATIO = 0.5;

/**
 * 見開きを基準にした組（カードの添字の対）。
 *
 * 見開きの後ろは直後から 2 枚ずつ組み、余った 1 枚は次の見開きの直前に残す。
 * 最初の見開きより前は、見開きの直前から遡って組む（余りは先頭の表紙側）。
 */
export function spreadPairs(cells: GridCell[]): [number, number][] {
  const pairs: [number, number][] = [];
  let pages: number[] = [];
  let anchored = false;
  const flush = () => {
    const start = anchored ? 0 : pages.length % 2;
    for (let at = start; at + 1 < pages.length; at += 2)
      pairs.push([pages[at], pages[at + 1]]);
    pages = [];
  };
  cells.forEach((cell, index) => {
    if (isSpread(cell)) {
      flush();
      anchored = true;
      if (cell.half === 0) pairs.push([index, index + 1]);
    } else if (cell.pairable && cell.half === undefined) {
      pages.push(index);
    }
  });
  if (anchored) flush();
  return pairs;
}

/** CSS Grid の自動配置（行優先・詰めない）を真似て、各カードの行を返す */
export function rowsOf(cells: GridCell[], columns: number): number[] {
  let row = 0;
  let column = 0;
  return cells.map((cell) => {
    const span = Math.min(cell.span, columns);
    if (column + span > columns) {
      row += 1;
      column = 0;
    }
    const placed = row;
    column += span;
    return placed;
  });
}

/** 組が 2 行に分かれる数 */
function splitPairs(cells: GridCell[], columns: number): number {
  const rows = rowsOf(cells, columns);
  return spreadPairs(cells).filter(([a, b]) => rows[a] !== rows[b]).length;
}

/**
 * 組が分かれない列数。分かれない列数が無ければ、分かれる組が最も少ない列数。
 * 同点なら maxColumns に近い（カードが小さい）方を選ぶ。見開きの無い本は
 * maxColumns のまま。
 */
export function spreadAlignedColumns(
  cells: GridCell[],
  maxColumns: number,
): number {
  if (maxColumns < 2 || !cells.some(isSpread)) return maxColumns;
  const lowest = Math.max(2, Math.ceil(maxColumns * MIN_COLUMN_RATIO));
  let best = maxColumns;
  let bestSplits = splitPairs(cells, maxColumns);
  for (let columns = maxColumns - 1; columns >= lowest; columns--) {
    if (bestSplits === 0) break;
    const splits = splitPairs(cells, columns);
    if (splits < bestSplits) {
      best = columns;
      bestSplits = splits;
    }
  }
  return best;
}
