/**
 * 利用者が直した巻数（サイドバー案 段階 5）。
 *
 * 描画も通信もしない純関数だけにしてある。直した値は本の鍵（元のアーカイブ +
 * 位置）で覚え、解析をやり直して行が組み直されても消えない。チェックの台帳
 * （``Decisions``）と同じ考え方。
 */

import { VOLUME_UNCERTAIN, VOLUME_UNKNOWN, type PlanRow } from "./plan";

/** 本の鍵 → 直した巻数。null は「巻数を付けない（Unknown）」 */
export type VolumeCorrections = ReadonlyMap<string, number | null>;

/**
 * 直した巻数を行へ当てる。名前・印・依頼は全部ここを通った行から作る。
 *
 * 直した行からは巻数の印（読めない・怪しい）を外す。利用者が決めた値に
 * 「怪しい」と言い続けると、直したのに直っていないように見える。
 * 整理済みの本には当てない（直せない。利用者の決定）。
 */
export function applyVolumes(
  rows: PlanRow[],
  volumes: VolumeCorrections,
): PlanRow[] {
  if (volumes.size === 0) return rows;
  return rows.map((row) => {
    if (row.kind !== "book" || row.organized || !volumes.has(row.id))
      return row;
    return {
      ...row,
      volume: volumes.get(row.id) ?? null,
      issues: row.issues.filter(
        (issue) => issue !== VOLUME_UNKNOWN && issue !== VOLUME_UNCERTAIN,
      ),
    };
  });
}

/**
 * 同じ入れ物の中で、指定した本より後ろの本に続き番号を振る。
 *
 * 範囲を同じ入れ物に限るのは、隣のアーカイブの正しい番号を巻き込まない
 * ため。合本の上下や、1 つの ZIP に入った数巻を直す手間を減らす用。
 */
export function numberFollowing(
  rows: PlanRow[],
  id: string,
  start: number,
): Map<string, number> {
  const index = rows.findIndex((row) => row.id === id);
  const from = rows[index];
  const next = new Map<string, number>();
  if (!from) return next;
  const container = from.ancestors[from.ancestors.length - 1];
  let volume = start;
  for (const row of rows.slice(index + 1)) {
    if (row.kind !== "book" || row.organized) continue;
    if (row.ancestors[row.ancestors.length - 1] !== container) continue;
    volume += 1;
    next.set(row.id, volume);
  }
  return next;
}

/**
 * 名前の中で、巻数として読んだ数字の位置。
 *
 * 型（第3巻）でも最後の数字でも、値が巻数と同じ最後の数字の並びを採る。
 * 型の読み方そのものを画面へ写さないための近似で、塗る場所を外しても
 * 巻数そのものは変わらない。見つからなければ塗らない。
 */
export function readDigits(
  name: string,
  volume: number | null,
): { before: string; digits: string; after: string } | null {
  if (volume === null) return null;
  let found: RegExpExecArray | null = null;
  for (const match of name.matchAll(/\d+/g)) {
    if (Number(match[0]) === volume) found = match;
  }
  if (!found || found.index === undefined) return null;
  return {
    before: name.slice(0, found.index),
    digits: found[0],
    after: name.slice(found.index + found[0].length),
  };
}
