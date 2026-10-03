/**
 * ファイル整理の画面が出す文言。
 *
 * 画面の組み立てから離して置く。どれも「どう書くか」で利用者の行動が
 * 変わる文で、条件の分かれ方そのものが仕様になっている。JSX の中に
 * 埋めると、なぜその分かれ方なのかが読み取れなくなる。
 */

import type { Analysis } from "./analysis";
import { TOC_UNREADABLE, type PlanRow } from "./plan";

/**
 * 実行し終わったときの状態の文言。
 *
 * ジョブは 1 冊も出来なくても走り切って succeeded で終わるので、件数だけを
 * 「整理しました」に添えると、全件失敗が「0 冊を整理しました」という成功の
 * 報告になってしまう。出来た数と失敗した数を別々に見て文言を選ぶ。
 */
export function organizeSummary(
  producedCount: number,
  failedCount: number,
): string {
  if (failedCount === 0) return `${producedCount} 冊を整理しました`;
  // 1 冊も出来ていないなら「整理しました」とは言わない
  if (producedCount === 0)
    return `整理できませんでした（${failedCount} 件失敗）`;
  return `${producedCount} 冊を整理しました（${failedCount} 件失敗）`;
}

/**
 * 状態の行に乗せる説明（#73 段階 4b）。
 *
 * 状態の行は 1 行に収めるので、なぜ作られないのかまでは書き切れない。
 * 溢れる分をここに置く。無いと、整理済みの本がどこへ行ったのかを画面から
 * 知る手立てが無くなる。
 */
export const ORGANIZED_STATUS_TIP =
  "整理済みの本は元の場所に残り、出力先には作りません。" +
  "出力先にも作るならチェックを入れてください";

/**
 * 主操作の行に出す、押したら何が起きるかの 1 行。
 *
 * 外した冊数と整理済みの冊数は 0 のときに出さない。何も起きていないのに
 * 「0 冊を外した」と書くと、外す操作をした後の状態と見分けが付かない。
 *
 * 外した本と整理済みの本は別の言葉で数える。理由が違うので、まとめると
 * 「外した覚えのない本を外したと言われる」ことになる。
 */
export function planSummary(
  keptCount: number,
  droppedCount: number,
  organizedCount: number,
): string {
  const dropped = droppedCount > 0 ? ` · ${droppedCount} 冊を外した` : "";
  const organized =
    organizedCount > 0
      ? ` · ${organizedCount} 冊は整理済みなので作りません`
      : "";
  if (keptCount > 0) return `${keptCount} 冊を作ります${dropped}${organized}`;
  // 1 冊も作らない場面で「0 冊を作ります」と言うと、押せば何かが起きるように
  // 読める。何が起きないのかと、どうすれば起きるのかを出す
  if (droppedCount === 0 && organizedCount > 0)
    return (
      `${organizedCount} 冊はすべて整理済みなので作りません` +
      ` · 出力先にも作るならチェックを入れてください`
    );
  return `作る本がありません${dropped}${organized}`;
}

/**
 * 作品情報の見出しに添える、左の列が何に使われるかの一言（#73 段階 4b）。
 *
 * 整理済みの本が混ざると、左の列は「残した本のうち自分の名前を持たないもの」
 * にしか使われなくなる。使われないときに黙っていると、打っても何も変わらない
 * 欄の前で利用者が詰まる。
 */
export function nameHint(keptCount: number, namelessCount: number): string {
  if (keptCount === 0) return "今は使いません · 作る本がありません";
  if (namelessCount === 0) return "今は使いません · 残した本は整理済み";
  return `整理済みでない ${namelessCount} 冊の名前に使います`;
}

/** 目次を読めない入れ物に添える説明。行に乗せると出る */
export const RUNTIME_TIP = "目次を読めないので、整理のときに展開して判定します";

/**
 * 左の「投入したもの」の行に出す、そこから出来るものの数（サイドバー案 段階 2B）。
 *
 * 右の一覧と同じ行（``buildPlanRows`` の結果）から数える。左が別の根拠で
 * 数えると、右に並ぶ本と左の冊数が食い違う。
 *
 * - 目次を読めない入れ物は 0 冊と書かない。中身は実行時に展開して分かる
 * - 何も見つからなかったと言えるのは解析が済んだときだけ。断られたり
 *   止まったりしたときに「ありません」と言うと嘘になる
 */
export function sourceCount(
  rows: PlanRow[],
  source: string,
  analysis: Pick<Analysis, "running" | "settled">,
): { text: string; tone: "muted" | "warn" | "busy"; title?: string } | null {
  let books = 0;
  let organized = 0;
  let runtime = 0;
  let isFolder = false;
  for (const row of rows) {
    const own = row.id === source || row.ancestors[0] === source;
    if (!own) continue;
    if (row.id === source) isFolder = row.kind === "folder";
    if (row.kind === "book") {
      books += 1;
      if (row.organized) organized += 1;
    } else if (row.issues.includes(TOC_UNREADABLE)) {
      runtime += 1;
    }
  }

  if (books === 0 && runtime === 0) {
    if (analysis.running) return { text: "解析中", tone: "busy" };
    if (analysis.settled)
      return { text: "アーカイブがありません", tone: "warn" };
    return null;
  }
  if (books === 0) {
    return {
      text: isFolder ? `${runtime} 件は実行時に判定` : "実行時に判定",
      tone: "muted",
      title: RUNTIME_TIP,
    };
  }
  if (runtime > 0) {
    return {
      text: `${books} 冊 · ${runtime} 件は実行時に判定`,
      tone: "muted",
      title: RUNTIME_TIP,
    };
  }
  if (organized === books)
    return { text: `${books} 冊 · 整理済み`, tone: "muted" };
  return { text: `${books} 冊`, tone: "muted" };
}
