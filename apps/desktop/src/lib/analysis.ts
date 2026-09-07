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
  /** 走査で見つかった入れ物。処理する順 */
  containers: string[];
  /** 目次を読めた入れ物から出来る本 */
  books: PlannedBook[];
  /** 目次を読めなかった入れ物 */
  unreadable: string[];
};

export const IDLE_ANALYSIS: Analysis = {
  running: false,
  containers: [],
  books: [],
  unreadable: [],
};

/**
 * 解析ジョブの結果から、一覧に要るものを取り出す。
 *
 * 走り始めた直後の結果は空なので、受け取る側が毎回それを気にしなくて済むよう
 * ここで形を揃える。
 */
export function analysisResult(result: unknown): Omit<Analysis, "running"> {
  const value = result as {
    containers?: string[];
    books?: PlannedBook[];
    unreadable?: { source: string; reason: string }[];
  } | null;
  return {
    containers: value?.containers ?? [],
    books: value?.books ?? [],
    unreadable: (value?.unreadable ?? []).map((item) => item.source),
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
