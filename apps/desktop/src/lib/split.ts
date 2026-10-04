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
   * 結合した（#139）ページ。分割を提案しない（#151）
   */
  kept_whole: boolean;
  /** 次の行と継ぎ目の色がつながっていて、2 枚で 1 枚の見開きらしいか（#149） */
  merge_suggested: boolean;
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
  /** 見開きのまま残すと決めた行（kept_whole）。分割を提案しない */
  keptWhole: boolean;
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
  /**
   * この行への提案に「このまま」と答えたか（#151）。本には書かない。
   * 開き直せば、同じ提案がまた出る
   */
  declined: boolean;
  stored: { checked: boolean; x: number };
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
      merge_suggested: row.merge_suggested === true,
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
 * 割ってから戻した・結合した見開き（kept_whole）は、見開きとして扱うが
 * 分割は提案しない（#151）。
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
      checked,
      x,
      displaced: row.displaced,
      mergeNext: false,
      suggested: row.merge_suggested,
      declined: false,
      stored: { checked: row.split !== null, x },
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

/** 提案の種類と、それへの答え（#151） */
export type Proposal = {
  kind: "split" | "merge";
  state: "open" | "accepted" | "declined";
};

/** 提案への答え。reopen は答えを取り消して未決へ戻す */
export type Answer = "accept" | "decline" | "reopen";

/**
 * index の行への提案。無ければ null（#151）。
 *
 * 分割は、横長でまだ割っておらず、見開きのまま残すと決めた行でもないページに
 * 出す。自分で結合した・戻した見開きにまで出すと、また分けるよう勧めることに
 * なる。結合は、継ぎ目の色がつながっていて（#149）いま結合できる 2 枚に出す。
 *
 * 答えは提案の有無を変えず、状態だけを変える。前後の送りの並びが、答える
 * たびに動かないようにするため。
 */
export function proposalOf(rows: SplitRow[], index: number): Proposal | null {
  const row = rows[index];
  const state = (accepted: boolean): Proposal["state"] =>
    accepted ? "accepted" : row.declined ? "declined" : "open";
  if (row.detected && !row.keptWhole && !row.stored.checked) {
    return { kind: "split", state: state(row.checked) };
  }
  if (row.suggested && canMergeNext(rows, index)) {
    return { kind: "merge", state: state(row.mergeNext) };
  }
  return null;
}

/** index の行の提案に答えた一覧。提案の無い行なら何も変えない */
export function answeredRows(
  rows: SplitRow[],
  index: number,
  answer: Answer,
): SplitRow[] {
  const proposal = proposalOf(rows, index);
  if (proposal === null) return rows;
  const on = answer === "accept";
  return replaceRow(rows, index, {
    ...(proposal.kind === "split" ? { checked: on } : { mergeNext: on }),
    declined: answer === "decline",
  });
}

/**
 * まだ答えていない提案を、すべて採用した一覧。「このまま」と答えた提案は
 * そのまま残す。利用者が一度断ったものを、まとめての操作で覆さないため
 */
export function acceptedAll(rows: SplitRow[]): SplitRow[] {
  let next = rows;
  for (let index = 0; index < next.length; index += 1) {
    if (proposalOf(next, index)?.state === "open") {
      next = answeredRows(next, index, "accept");
    }
  }
  return next;
}

/** 分割の対象になりうる行。判定に漏れても、手で入れれば対象になる */
export function isCandidate(row: SplitRow): boolean {
  return row.detected || row.checked;
}

/** 保留を全部捨て、開いたときの姿へ戻す */
export function restoredRows(rows: SplitRow[]): SplitRow[] {
  return rows.map((row) => ({
    ...row,
    checked: row.stored.checked,
    x: row.stored.x,
    mergeNext: false,
    declined: false,
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
    if (isAbsorbed(rows, index)) return [next - 1];
    const numbers = row.checked ? [next, next + 1] : [next];
    next += numbers.length;
    return numbers;
  });
}

/** 番号の札に出す文字。2 ページ分は範囲で書く */
export function numberLabel(numbers: number[]): string {
  return numbers.length === 2
    ? `${numbers[0]}${RANGE_DASH}${numbers[1]}`
    : `${numbers[0]}`;
}

/** 確定したときのページ数 */
export function resultTotal(rows: SplitRow[]): number {
  return rows.reduce(
    (total, row, index) =>
      total + (isAbsorbed(rows, index) ? 0 : row.checked ? 2 : 1),
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
        },
      ];
    }
    return [
      {
        names: row.names,
        split: row.checked ? { x: row.x } : null,
        merge: false,
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
  if (fresh > 0) parts.push(`${fresh} 枚を 2 ページに分けます`);
  if (moved > 0) parts.push(`${moved} 枚の分割位置を直します`);
  if (reverted > 0) parts.push(`${reverted} 枚を 1 ページに戻します`);
  if (joined > 0) parts.push(`離れた見開き ${joined} 組を隣り合わせに戻します`);
  if (merged > 0) parts.push(`${merged} 組を 1 ページに結合します`);
  if (parts.length === 0) {
    // 何も採用していないときは、次に何をすればよいかを言う（#142 #151）
    const open = rows.filter(
      (_, index) => proposalOf(rows, index)?.state === "open",
    ).length;
    return open > 0 ? "採用する提案を選んでください" : "変更はありません";
  }
  const changesCount = fresh > 0 || reverted > 0 || merged > 0;
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
  if (parts.length === 0) return "変更はありませんでした";
  return `${parts.join(" · ")}（全 ${result.page_count} ページ）`;
}
