/**
 * ページ一覧の各カードを、どの行・列に置くか。
 *
 * 人が結合や見開きを目で確かめるとき、組になる 2 枚が行の末尾と次の行の
 * 先頭に分かれると見比べにくい。検出済みの見開きを基準に前後のページを
 * 2 枚ずつ組み、行ごとに「組・見開き・余りの 1 枚」を入るだけ詰める。
 * 列数を本全体で 1 つに決めると、どこかの組を揃えるために全部の行が
 * 縮み、左に広い空きが出る。行ごとに詰めれば、空くのは行末の 1 枠までで済む。
 *
 * 右から左のときは各行を右端から詰める。格子に direction: rtl を付けると、
 * 1 行目は右に寄るが 2 行目以降が左に残るため、列番号はここで決める。
 */

/** 格子に置く 1 枚 */
export type GridCell = {
  /** 2 は見開きのように 2 列ぶんを占める */
  span: 1 | 2;
  /** 割って保存した見開きの半分。0 の直後に 1 が並び、2 枚で 1 つの見開きとして扱う */
  half?: 0 | 1;
};

/** 1 枚の置き場所。column は 1 始まりで左端の列、row も 1 始まり */
export type PageSlot = {
  column: number;
  row: number;
  span: 1 | 2;
};

/**
 * 同じ行に並べる単位（カードの添字の並び）に分ける。
 *
 * 見開きの後ろは直後から 2 枚ずつ組み、1 枚余るときは次の見開きの直前に残す。
 * 最初の見開きより前は、見開きから遡って組む（余りは先頭の表紙側）。
 * 見開きが無い本は組まない。
 */
export function pageGroups(cells: ReadonlyArray<GridCell>): number[][] {
  const groups: number[][] = [];
  let pages: number[] = [];
  let anchored = false;
  const flush = () => {
    const start = anchored ? 0 : pages.length % 2;
    pages.slice(0, start).forEach((page) => groups.push([page]));
    for (let at = start; at < pages.length; at += 2) {
      groups.push(pages.slice(at, at + 2));
    }
    pages = [];
  };
  const hasSpread = cells.some((cell) => cell.span === 2 || cell.half === 0);
  cells.forEach((cell, index) => {
    if (cell.half === 1) return;
    if (cell.span === 2 || cell.half === 0) {
      flush();
      anchored = true;
      groups.push(cell.half === 0 ? [index, index + 1] : [index]);
    } else if (hasSpread) {
      pages.push(index);
    } else {
      groups.push([index]);
    }
  });
  flush();
  return groups;
}

/**
 * cells を最大 columns 列の格子へ置く。fromRight なら各行を右端から詰める。
 *
 * 単位ごとに、今の行に入るなら続けて置き、入らなければ次の行へ回す。
 * 1 列しか入らない幅では、見開きも組も 1 枚ずつ縦に並べる。
 */
export function placePages(
  cells: ReadonlyArray<GridCell>,
  columns: number,
  fromRight: boolean,
): PageSlot[] {
  const width = Math.max(1, columns);
  const spanOf = (index: number): 1 | 2 =>
    cells[index].span === 2 && width >= 2 ? 2 : 1;
  const slots: PageSlot[] = [];
  let row = 1;
  let used = 0;
  for (const group of pageGroups(cells)) {
    const groupWidth = group.reduce((sum, index) => sum + spanOf(index), 0);
    if (used > 0 && used + groupWidth > width) {
      row += 1;
      used = 0;
    }
    for (const index of group) {
      const span = spanOf(index);
      if (used + span > width) {
        row += 1;
        used = 0;
      }
      const column = fromRight ? width - used - span + 1 : used + 1;
      slots[index] = { column, row, span };
      used += span;
    }
  }
  return slots;
}
