/**
 * ページ分割の画面が使う計算（#58 段階 3）。
 *
 * 番号の数え直し・保留の判定・状態欄の文・分割線の可動域を、描画から切り離して
 * ここに集める。どれも「どこにも書いていない規則」ではなく、画面の意味そのもの
 * なので、部品の中に散らすと同じ規則が少しずつ違う形で 3 つ現れる。
 *
 * **番号はファイル名から作らない。** チェックの結果から数え直す。名前から作ると、
 * 割った直後に 002.png が「2 ページ目の右半分」になり、以降の番号がすべて 1 つ
 * ずれる。利用者はページ番号を頼りに見開きを探すので、そのずれはそのまま作業の
 * やり直しになる。
 */

/** 見開きと判定する縦横比。manga_core.cover_editor と同じ値 */
export const SPREAD_RATIO = 1.2;

/**
 * 分割線を寄せられる限界（画像の幅に対する割合）。
 *
 * 左右どちらの半分にも 1 割は残す。端まで寄せられると、幅 1px のページが
 * できてしまい、割ったのか壊したのか画面からは見分けが付かない。
 */
const EDGE_FRACTION = 0.1;

/** 番号の区切り。範囲だと一目で分かる EN DASH（U+2013） */
const RANGE_DASH = "–";

/**
 * 走査ジョブが返す 1 行（manga_api.split_job.SplitRowView）。
 *
 * 割った対は 1 行に畳まれて names が 2 つになる。画面はその区別を出さない。
 */
export type SplitScanRow = {
  names: string[];
  width: number;
  height: number;
  /** 行の画素の出どころ。"original" は割る前の絵を指す */
  source: string;
  is_spread: boolean;
  split: { x: number } | null;
  /** 割った対の 2 枚がいま隣り合っていないか（#133） */
  displaced: boolean;
  /**
   * 見開きのまま残すと決めたページか。割ってから戻した（#138）・2 ページを
   * 結合した（#139）ページ。「結合・復元した画像」として分割対象を選べる
   */
  kept_whole: boolean;
  deleted: boolean;
  /** 次の行と継ぎ目の色がつながっていて、2 枚で 1 枚の見開きらしいか（#149） */
  merge_suggested: boolean;
  /** 割った対の 2 枚の継ぎ目がつながっていて、戻せば見開きらしいか（#154） */
  rejoin_suggested: boolean;
};

/** 走査ジョブの結果（manga_api.split_job.SplitScanView） */
export type SplitScanResult = {
  archive: string;
  page_count: number;
  token: string;
  rows: SplitScanRow[];
};

/** 確定ジョブの結果（manga_api.split_job.SplitResultView） */
export type SplitConfirmResult = {
  changed: boolean;
  page_count: number;
  split_count: number;
  restored_count: number;
  adjusted_count: number;
  joined_count: number;
  merged_count: number;
};

/**
 * 画面が持つ 1 行。
 *
 * `stored` は開いたときの姿。いま ZIP に書かれている状態そのものなので、
 * これと見比べて初めて「何を保留しているか」が決まる。
 */
export type SplitRow = {
  names: string[];
  width: number;
  height: number;
  source: string;
  /** 見開き（横長）と判定した行 */
  detected: boolean;
  /** 結合・復元して 1 枚にした行（kept_whole） */
  keptWhole: boolean;
  deleted: boolean;
  checked: boolean;
  /** 割る位置。元画像の画素で持ち、描画のときだけ割合に直す */
  x: number;
  /**
   * 割った対の 2 枚が、ページ並べ替えで離れた位置にある（#133）。行は先に
   * 出てくる方の位置に置かれ、確定するとそこで 2 枚が隣り合う。黙って動かさない
   * よう、開いた時点から保留として数える
   */
  displaced: boolean;
  /**
   * 次の行と 1 枚の見開きへ結合する（#139）。保留の 1 つで、確定するまで
   * 書き込まない。結合される次の行は、この行に吸い込まれて格子から消える
   */
  mergeNext: boolean;
  /**
   * 次の行との結合を勧める（#149）。継ぎ目の色がつながっている 2 枚。示す
   * だけで保留にはしない。開いた時点で何も選ばないのは分割と同じ（#142）
   */
  suggested: boolean;
  /** 割った対を、割る前の 1 枚へ戻すよう勧める（#154） */
  rejoin: boolean;
  stored: { checked: boolean; x: number; deleted: boolean };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positionOf(value: unknown): { x: number } | null {
  if (!isRecord(value)) return null;
  return typeof value.x === "number" ? { x: value.x } : null;
}

/**
 * 走査の結果を読み取る。
 *
 * ジョブの結果は型の付かない値として届くので、並べる前にここで形を確かめる。
 * 壊れた行をそのまま通すと、幅 0 の見開きが掴めない線として出たり、名前の
 * 無い行のまま確定して別のページが割られる。
 */
export function scanResultOf(value: unknown): SplitScanResult {
  if (!isRecord(value) || !Array.isArray(value.rows)) {
    throw new Error("見開きの走査結果を読み取れませんでした");
  }
  const rows = value.rows.map((row: unknown) => {
    if (
      !isRecord(row) ||
      !Array.isArray(row.names) ||
      row.names.length === 0 ||
      !row.names.every((name: unknown) => typeof name === "string") ||
      typeof row.width !== "number" ||
      typeof row.height !== "number" ||
      row.width <= 0 ||
      row.height <= 0
    ) {
      throw new Error("見開きの走査結果を読み取れませんでした");
    }
    return {
      names: row.names as string[],
      width: row.width,
      height: row.height,
      source: typeof row.source === "string" ? row.source : "page",
      is_spread: row.is_spread === true,
      split: positionOf(row.split),
      displaced: row.displaced === true,
      kept_whole: row.kept_whole === true,
      deleted: row.deleted === true,
      merge_suggested: row.merge_suggested === true,
      rejoin_suggested: row.rejoin_suggested === true,
    };
  });
  return {
    archive: typeof value.archive === "string" ? value.archive : "",
    page_count:
      typeof value.page_count === "number"
        ? value.page_count
        : rows.reduce((total, row) => total + row.names.length, 0),
    token: typeof value.token === "string" ? value.token : "",
    rows,
  };
}

/** 確定の結果を読み取る。数えられなかった欄は 0 として扱う */
export function confirmResultOf(value: unknown): SplitConfirmResult {
  const source = isRecord(value) ? value : {};
  const count = (key: string) =>
    typeof source[key] === "number" ? (source[key] as number) : 0;
  return {
    changed: source.changed === true,
    page_count: count("page_count"),
    split_count: count("split_count"),
    restored_count: count("restored_count"),
    adjusted_count: count("adjusted_count"),
    joined_count: count("joined_count"),
    merged_count: count("merged_count"),
  };
}

/** 画像の中央。既定の分割位置になる */
export function centerOf(width: number): number {
  return Math.floor(width / 2);
}

/** 分割線を動かせる範囲。読み上げの aria-valuemin / max もこの値 */
export function splitBounds(width: number): { min: number; max: number } {
  return {
    min: Math.round(width * EDGE_FRACTION),
    max: Math.round(width * (1 - EDGE_FRACTION)),
  };
}

/** 分割線を可動域へ収める */
export function clampSplit(x: number, width: number): number {
  const bounds = splitBounds(width);
  return Math.min(Math.max(Math.round(x), bounds.min), bounds.max);
}

/**
 * 走査の行を、画面が持つ行へ直す。
 *
 * チェックは既に割ってある行にだけ入れる。開いた時点では何も保留にしない
 * （#142）。見開きと判定した行を分けるかどうかは利用者が選ぶ（まとめて選ぶ
 * 操作もある）。黙ってチェックを入れておくと、気づかずに確定した見開きが
 * 割れる。既に割ってある行は比が閾値の下でもチェックを入れる。外れていたら、
 * 開き直しただけで「割る前へ戻します」になってしまう。
 *
 * 割ってから戻した・結合した画像（kept_whole）は、元から横長の画像と分けて扱う。
 */
export function rowsFrom(result: SplitScanResult): SplitRow[] {
  return result.rows.map((row) => {
    const checked = row.split !== null;
    const x = row.split?.x ?? centerOf(row.width);
    return {
      names: row.names,
      width: row.width,
      height: row.height,
      source: row.source,
      detected: row.is_spread,
      keptWhole: row.kept_whole,
      deleted: row.deleted,
      checked,
      x,
      displaced: row.displaced,
      mergeNext: false,
      suggested: row.merge_suggested,
      rejoin: row.rejoin_suggested,
      stored: { checked: row.split !== null, x, deleted: row.deleted },
    };
  });
}

/** 2 列ぶんを占める横長か。チェックの有無では変わらない、絵そのものの形 */
export function isWide(row: SplitRow): boolean {
  return row.width / row.height >= SPREAD_RATIO;
}

/**
 * 書き込む前と違うか。番号を青くするのも主操作を押せるのもこれで決まる。
 *
 * 離れた対は、割ったままでも確定すれば隣り合わせに動く。触っていなくても
 * 保留として数え、動くことを利用者に見せる（#133）。
 */
export function isPending(row: SplitRow): boolean {
  return (
    row.mergeNext ||
    row.deleted !== row.stored.deleted ||
    row.checked !== row.stored.checked ||
    (row.checked && (row.x !== row.stored.x || row.displaced))
  );
}

/** 前の行に結合されて、格子から消えている行か（#139） */
export function isAbsorbed(rows: SplitRow[], index: number): boolean {
  return rows[index - 1]?.mergeNext === true;
}

/**
 * index の行を次の行と結合できるか（#139）。
 *
 * 単ページ 2 枚に限る。割る行・割ってある対・横長を混ぜると、結合と分割の
 * どちらが効くのか画面から読めなくなる。3 枚以上を数珠つなぎにもしない。
 */
export function canMergeNext(rows: SplitRow[], index: number): boolean {
  const single = (row: SplitRow | undefined) =>
    row !== undefined &&
    !row.deleted &&
    row.names.length === 1 &&
    !row.checked &&
    !row.detected &&
    !isWide(row);
  const next = rows[index + 1];
  return (
    single(rows[index]) &&
    single(next) &&
    !next.mergeNext &&
    !isAbsorbed(rows, index)
  );
}

/** 画面のモード。ページを分割・ページを結合 */
export type Step = "split" | "merge";
export type SplitSource = "original" | "edited" | "all";

/**
 * 選んだ種類で、まだ分割していない画像。既定では元から横長の画像だけを対象にする。
 * 結合・復元した画像は記録で区別し、縦横比にかかわらず対象にできる。
 */
export function isSplitTarget(
  row: SplitRow,
  source: SplitSource = "original",
): boolean {
  if (row.deleted) return false;
  if (row.mergeNext || (row.stored.checked && !row.checked))
    return source !== "original";
  if (row.stored.checked) return false;
  return row.keptWhole
    ? source !== "original"
    : row.detected && source !== "edited";
}

/**
 * ②の結合候補（#149 #153）。継ぎ目の色がつながっていて、いま結合できる 2 枚。
 * index は先のページの行
 */
export function isMergeCandidate(rows: SplitRow[], index: number): boolean {
  return (
    rows[index].suggested &&
    !rows[index].keptWhole &&
    !rows[index + 1]?.keptWhole &&
    canMergeNext(rows, index)
  );
}

/**
 * ②で、割った対を割る前の 1 枚へ戻す候補（#154）。2 枚の継ぎ目の色が
 * つながっている対。①で全部の横長を分けたあと、本当の見開きだけを戻す
 */
export function isRejoinCandidate(row: SplitRow): boolean {
  return (
    !row.deleted && row.names.length === 2 && row.rejoin && row.stored.checked
  );
}

/** ②の候補（送りボタンが辿り、Enter で切り替える行） */
export function isMergeTarget(rows: SplitRow[], index: number): boolean {
  const row = rows[index];
  if (row.deleted || isAbsorbed(rows, index)) return false;
  return (
    row.keptWhole ||
    row.mergeNext ||
    (row.names.length === 2 && !row.checked) ||
    isMergeCandidate(rows, index) ||
    isRejoinCandidate(row)
  );
}

/**
 * 開いたときのステップ。①の対象があれば①から始める。中身が全部見開きの本は
 * ①から、ふつうの本や仕上げた本は②から始まる。
 *
 * 離れた対（#133）がある本も①から始める。離れた対は開いた時点で保留に数えるので、
 * ②から開くと、何も触っていないのに①へ移るたび「保存していない変更」を
 * 確かめられる
 */
export function firstStep(rows: SplitRow[]): Step {
  return rows.some((row) => isSplitTarget(row) || row.displaced)
    ? "split"
    : "merge";
}

/** 選んだ種類の対象をすべて分ける */
export function splitAll(
  rows: SplitRow[],
  source: SplitSource = "original",
): SplitRow[] {
  return rows.map((row) =>
    isSplitTarget(row, source) && (row.mergeNext || !row.checked)
      ? splitRow(row)
      : row,
  );
}

/** 未保存の結合は取り消し、保存済みの画像は分割する */
export function splitRow(row: SplitRow): SplitRow {
  return row.mergeNext
    ? { ...row, mergeNext: false }
    : { ...row, checked: !row.checked };
}

/** ②の候補をすべて結合する。割った対の候補は割る前へ戻す */
export function mergeAll(rows: SplitRow[]): SplitRow[] {
  let next = rows;
  for (let index = 0; index < next.length; index += 1) {
    if (isMergeCandidate(next, index) && !next[index].mergeNext) {
      next = replaceRow(next, index, { mergeNext: true });
    } else if (isRejoinCandidate(next[index]) && next[index].checked) {
      next = replaceRow(next, index, { checked: false });
    }
  }
  return next;
}

/**
 * 両モード共通の格子に並べる 1 枚ぶん。
 *
 * ページ単位で並べる。割った対は 2 枚の単ページとして出し、継ぎ目が
 * つながる対だけを、割る前の 1 枚（結合の候補）として出す。
 */
export type PageUnit = {
  /** 格子の中で 1 つに決まる名前。割った対の半分は行の番号と part で分ける */
  key: string;
  /**
   * - page: 1 ページ
   * - candidate: 結合の候補。結合した後の姿で出す
   * - joined: 結合すると決めた 2 枚
   * - spread: 保存済みの横長のページ（見開き）
   */
  kind: "page" | "candidate" | "joined" | "spread";
  /** 先頭の行 */
  row: number;
  /** 割った対の半分のとき、先（0）か後（1）か */
  part?: 0 | 1;
  /** 結合の手段。merge は次の行と貼り合わせる、rejoin は割った対を戻す */
  via?: "merge" | "rejoin";
};

/** 行から共通の並びを組み立てる */
export function pageUnits(rows: SplitRow[]): PageUnit[] {
  const units: PageUnit[] = [];
  rows.forEach((row, index) => {
    const previous = index - 1;
    // 結合する・結合の候補の 2 枚目は、1 枚目のカードに一緒に描く
    if (
      previous >= 0 &&
      (rows[previous].mergeNext || isMergeCandidate(rows, previous))
    ) {
      return;
    }
    const key = String(index);
    if (row.names.length === 2) {
      if (!row.checked) {
        units.push({ key, kind: "joined", row: index, via: "rejoin" });
      } else if (isRejoinCandidate(row)) {
        units.push({ key, kind: "candidate", row: index, via: "rejoin" });
      } else {
        units.push({ key: `${key}:0`, kind: "page", row: index, part: 0 });
        units.push({ key: `${key}:1`, kind: "page", row: index, part: 1 });
      }
    } else if (isWide(row)) {
      units.push({ key, kind: "spread", row: index });
    } else if (row.mergeNext) {
      units.push({ key, kind: "joined", row: index, via: "merge" });
    } else if (isMergeCandidate(rows, index)) {
      units.push({ key, kind: "candidate", row: index, via: "merge" });
    } else {
      units.push({ key, kind: "page", row: index });
    }
  });
  return units;
}

/**
 * 「結合…」で相手に選べる 1 枚（#154）。格子は左から右へ、見開きは右から左へ
 * 読むので、「次」「前」と向きを言わずに相手そのものを押させる。
 *
 * 割った対の半分は、もう半分とだけ結合できる（割る前へ戻す）。ほかの単ページは、
 * 隣り合う単ページと結合できる。
 */
export function partnersOf(
  rows: SplitRow[],
  units: PageUnit[],
  unit: PageUnit,
): string[] {
  if (unit.kind !== "page" || rows[unit.row].deleted) return [];
  if (unit.part !== undefined) return [`${unit.row}:${1 - unit.part}`];
  const visible = units.filter((item) => !rows[item.row].deleted);
  const at = visible.findIndex((item) => item.key === unit.key);
  const partners: string[] = [];
  for (const other of [visible[at - 1], visible[at + 1]]) {
    if (!other || other.kind !== "page" || other.part !== undefined) continue;
    const [first, second] = [unit.row, other.row].sort((a, b) => a - b);
    if (canMergeNext([rows[first], rows[second]], 0)) partners.push(other.key);
  }
  return partners;
}

/** 2 枚を結合した一覧。a・b は partnersOf で選べる組であること */
export function joinedRows(
  rows: SplitRow[],
  a: PageUnit,
  b: PageUnit,
): SplitRow[] {
  if (a.part !== undefined) return replaceRow(rows, a.row, { checked: false });
  const [first, second] = [a.row, b.row].sort((x, y) => x - y);
  if (second === first + 1) return replaceRow(rows, first, { mergeNext: true });
  const next = [...rows];
  const [partner] = next.splice(second, 1);
  next.splice(first + 1, 0, partner);
  return next.map((row, index) => ({
    ...row,
    suggested: false,
    mergeNext: index === first || row.mergeNext,
  }));
}

/** 分割の対象になりうる行。判定に漏れても、手で入れれば対象になる */
export function isCandidate(
  row: SplitRow,
  source: SplitSource = "original",
): boolean {
  return !row.deleted && (isSplitTarget(row, source) || row.checked);
}

/** 保留を全部捨て、開いたときの姿へ戻す */
export function restoredRows(rows: SplitRow[]): SplitRow[] {
  return rows.map((row) => ({
    ...row,
    checked: row.stored.checked,
    x: row.stored.x,
    deleted: row.stored.deleted,
    mergeNext: false,
  }));
}

/** 1 行を差し替えた新しい一覧。元の配列も行も書き換えない */
export function replaceRow(
  rows: SplitRow[],
  index: number,
  change: Partial<SplitRow>,
): SplitRow[] {
  return rows.map((row, at) => (at === index ? { ...row, ...change } : row));
}

/**
 * いまのチェックのままで確定したときの、行ごとのページ番号。
 * 結合されて消える行は、吸い込んだ行と同じ番号になる
 */
export function pageNumbers(rows: SplitRow[]): number[][] {
  let next = 1;
  return rows.map((row, index) => {
    if (row.deleted || (isAbsorbed(rows, index) && rows[index - 1].deleted))
      return [];
    if (isAbsorbed(rows, index)) return [next - 1];
    const numbers = row.checked ? [next, next + 1] : [next];
    next += numbers.length;
    return numbers;
  });
}

/** 番号の札に出す文字。2 ページ分は範囲で書く */
export function numberLabel(numbers: number[]): string {
  if (numbers.length === 0) return "削除済み";
  return numbers.length === 2
    ? `${numbers[0]}${RANGE_DASH}${numbers[1]}`
    : `${numbers[0]}`;
}

/** 確定したときのページ数 */
export function resultTotal(rows: SplitRow[]): number {
  return rows.reduce(
    (total, row, index) =>
      total +
      (row.deleted || isAbsorbed(rows, index) ? 0 : row.checked ? 2 : 1),
    0,
  );
}

/**
 * 確定で送る行（manga_api.split_job.SplitIntentRowView）。
 *
 * 結合する 2 行は 1 行にまとめ、結合することを明示して送る。割った対を戻す
 * 行と同じ形（2 つの名前と「割らない」）で送ると、サイドカーは見分けられない。
 */
export function intentRows(rows: SplitRow[]) {
  return rows.flatMap((row, index) => {
    if (isAbsorbed(rows, index)) return [];
    if (row.mergeNext) {
      return [
        {
          names: [...row.names, ...rows[index + 1].names],
          split: null,
          merge: true,
          deleted: row.deleted,
        },
      ];
    }
    return [
      {
        names: row.names,
        split: row.checked ? { x: row.x } : null,
        merge: false,
        deleted: row.deleted,
      },
    ];
  });
}

/**
 * 主操作の左に出す 1 行。「押したら何が起きるか」を数で言う。
 *
 * 割る・位置を直す・戻すを混ぜないのは、まとめると報告が嘘になるため。
 * ページ数が変わるときだけ、変わった先を添える。
 */
export function summaryOf(rows: SplitRow[]): string {
  const fresh = rows.filter((row) => row.checked && !row.stored.checked).length;
  const moved = rows.filter(
    (row) => row.checked && row.stored.checked && row.x !== row.stored.x,
  ).length;
  const reverted = rows.filter(
    (row) => !row.checked && row.stored.checked,
  ).length;
  const joined = rows.filter(
    (row) =>
      row.checked &&
      row.stored.checked &&
      row.x === row.stored.x &&
      row.displaced,
  ).length;
  const merged = rows.filter((row) => row.mergeNext).length;

  const parts: string[] = [];
  const removed = rows.filter(
    (row) => row.deleted && !row.stored.deleted,
  ).length;
  const restored = rows.filter(
    (row) => !row.deleted && row.stored.deleted,
  ).length;
  if (removed > 0) parts.push(`${removed} 件のページを削除します（復元可能）`);
  if (restored > 0) parts.push(`${restored} 件のページを復元します`);
  if (fresh > 0) parts.push(`${fresh} 枚を 2 ページに分けます`);
  if (moved > 0) parts.push(`${moved} 枚の分割位置を直します`);
  if (reverted > 0) parts.push(`${reverted} 枚を 1 ページに戻します`);
  if (joined > 0) parts.push(`離れた見開き ${joined} 組を隣り合わせに戻します`);
  if (merged > 0) parts.push(`${merged} 組を 1 ページに結合します`);
  if (parts.length === 0) {
    return "変更はありません";
  }
  const changesCount =
    fresh > 0 || reverted > 0 || merged > 0 || removed > 0 || restored > 0;
  // 分割と結合をまとめて採用すると文が長くなる。ツールバーに収まるよう短く書く
  const suffix = changesCount ? ` → 全 ${resultTotal(rows)} ページ` : "";
  return parts.join(" · ") + suffix;
}

/**
 * 書き込んだ後の報告。
 *
 * 割った・位置を直した・戻したを数で言い分ける。1 つにまとめると、位置を
 * 直しただけなのに「分割しました」と報告することになり、利用者は自分が
 * したことと違う結果を見せられる。
 */
export function doneMessage(result: SplitConfirmResult): string {
  const parts: string[] = [];
  if (result.split_count > 0) {
    parts.push(`${result.split_count} 枚を分割しました`);
  }
  if (result.adjusted_count > 0) {
    parts.push(`${result.adjusted_count} 枚の分割位置を直しました`);
  }
  if (result.restored_count > 0) {
    parts.push(`${result.restored_count} 枚を 1 ページに戻しました`);
  }
  if (result.joined_count > 0) {
    parts.push(
      `離れた見開き ${result.joined_count} 組を隣り合わせに戻しました`,
    );
  }
  if (result.merged_count > 0) {
    parts.push(`${result.merged_count} 組を 1 ページに結合しました`);
  }
  if (parts.length === 0)
    return result.changed
      ? "変更を反映しました"
      : "画像とページ順は変更していません";
  return `${parts.join(" · ")}（全 ${result.page_count} ページ）`;
}
