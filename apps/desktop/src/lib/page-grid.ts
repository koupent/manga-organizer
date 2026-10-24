/**
 * ページ一覧の各カードを、どの列に置くか。
 *
 * 列数は表示サイズで入る数のままにする。見開きに合わせて列を減らすと、
 * 窓を少し変えただけで 1 行の枚数が大きく跳ねる。見開きは 2 列ぶんを
 * 使い、行末に入りきらなければ次の行の先頭へ回す。
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
 * 列だけを指定して行を自動に任せるとは、右から置くとき 1 枚ずつ次の行へ
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
