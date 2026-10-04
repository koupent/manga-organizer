import type { OrganizeFailure } from "../components/FailedList";
import type { PlannedBook } from "./plan";

/**
 * ジョブの結果から、出来たファイルと失敗を取り出す。
 *
 * 走り切ったジョブは結果を持たないこともある。受け取る側が毎回
 * 空の場合を気にしなくて済むよう、ここで形を揃える。
 */
export function organizeResult(result: unknown): {
  produced: string[];
  failed: OrganizeFailure[];
} {
  const value = result as {
    produced?: string[];
    failed?: OrganizeFailure[];
  } | null;
  return { produced: value?.produced ?? [], failed: value?.failed ?? [] };
}

/**
 * 解析ジョブから読み取った、いまの解析の様子。
 *
 * 走っているかどうかまで同じジョブから決めるのは、行の中身と「解析中」の
 * 表示がずれないようにするため。別々に持つと、本が出そろっているのに主操作が
 * 押せない（あるいはその逆）という食い違いが起こる。
 */
export type Analysis = {
  running: boolean;
  /**
   * 解析が最後まで済んだか。
   *
   * 走っていないことと、済んだことは別。解析が断られたり止まったりした
   * ときに「中に何もありません」と言うと嘘になるので、何も見つからな
   * かったと言えるのは済んだときだけにする。
   */
  settled: boolean;
  /** 走査で見つかった入れ物。処理する順 */
  containers: string[];
  /** 目次を読めた入れ物から出来る本 */
  books: PlannedBook[];
  /** 目次を読めなかった入れ物 */
  unreadable: string[];
  /**
   * いま読んでいる入れ物の進み（0〜1）（#157）。大きな RAR 1 つを読む間、
   * 件数の進捗は 0 から動かないので、これを足して進み具合を見せる
   */
  reading: number;
};

export const IDLE_ANALYSIS: Analysis = {
  running: false,
  settled: false,
  containers: [],
  books: [],
  unreadable: [],
  reading: 0,
};

/**
 * 解析ジョブの結果から、一覧に要るものを取り出す。
 *
 * 走り始めた直後の結果は空なので、受け取る側が毎回それを気にしなくて済むよう
 * ここで形を揃える。
 */
export function analysisResult(
  result: unknown,
): Omit<Analysis, "running" | "settled"> {
  const value = result as {
    containers?: string[];
    books?: PlannedBook[];
    unreadable?: { source: string; reason: string }[];
    reading?: number;
  } | null;
  return {
    containers: value?.containers ?? [],
    books: value?.books ?? [],
    unreadable: (value?.unreadable ?? []).map((item) => item.source),
    reading: typeof value?.reading === "number" ? value.reading : 0,
  };
}

/**
 * 応答が前と同じかを見分ける印。
 *
 * 解析の途中経過は入れ物 1 つを読むごとにしか書かれないので、その合間の
 * 応答は前と同じものになる。中身を突き合わせると、1 万冊の一覧を毎回
 * 比べることになるため、動く所だけを見る。
 */
export function snapshotMark(job: {
  updated_at: string;
  state: string;
  current: number;
  total: number;
}): string {
  return [job.updated_at, job.state, job.current, job.total].join("/");
}

/**
 * 解析の投入を断られたパスと理由を、断りの応答から取り出す（#107）。
 *
 * サイドカーは 1 件でも断ると投入全体を通さず、断ったパスを ``refused`` に
 * 名指しして返す。名指しが無い失敗（通信の失敗など）は空を返す。
 */
export function refusedPaths(
  error: unknown,
): { path: string; reason: string }[] {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { refused?: unknown };
    if (!Array.isArray(parsed.refused)) return [];
    return parsed.refused.filter(
      (item): item is { path: string; reason: string } =>
        typeof item?.path === "string" && typeof item?.reason === "string",
    );
  } catch {
    return [];
  }
}
