import { AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";
import { SectionTitle } from "./ui/section-title";

/** 整理できなかったアーカイブ 1 件。どのファイルが、なぜ駄目だったか */
export type OrganizeFailure = { archive: string; reason: string };

/**
 * 一覧の高さの上限。
 *
 * 出来たファイルの一覧と同じ考え方で、中身の量で伸ばさない。失敗が多い
 * ときほど処理対象の一覧を押し縮めてしまうため、溢れた行はこの中で
 * スクロールさせる。次の行の頭が覗くので「まだ続きがある」と分かる。
 */
const LIST_MAX_HEIGHT = "max-h-[96px]";

/**
 * 整理できなかったファイルの一覧。
 *
 * ジョブは失敗してもそのまま走り切って succeeded で終わるので、状態の文言
 * だけでは何が起きたか伝わらない。処理ログを開かなくても気づけるよう、
 * 作業面の中に、出来たファイルの一覧と並べて置く。
 *
 * 名前と理由を必ず同じ行に出す。名前だけでは何をすればいいか分からず、
 * 理由だけではどのファイルの話か分からない。片方だけでは行動に繋がらない。
 *
 * 失敗が無いときは何も描かない（空を渡すのは呼び出し側の役目）。空の枠を
 * 残すと、実行前から「失敗する場所」が画面を占め続けることになる。
 */
export function FailedList({ failures }: { failures: OrganizeFailure[] }) {
  if (failures.length === 0) return null;

  return (
    <section className="flex shrink-0 flex-col gap-1" data-testid="failed-list">
      <div className="flex items-center gap-1.5">
        <SectionTitle>整理できなかったファイル</SectionTitle>
        <span className="tabular text-[11.5px] text-danger">
          {failures.length} 件
        </span>
      </div>

      <ul
        className={cn(
          "divide-y divide-line/60 overflow-y-auto rounded-card",
          "border border-danger/30 bg-danger/10",
          LIST_MAX_HEIGHT,
        )}
      >
        {failures.map((failure) => (
          <FailedItem key={failure.archive} failure={failure} />
        ))}
      </ul>
    </section>
  );
}

/** 失敗 1 件。名前と理由を横に並べる */
function FailedItem({ failure }: { failure: OrganizeFailure }) {
  // 出すのは名前だけにする。投入元の置き場所は行ごとに同じことが多く、
  // 並べても理由を読む幅を奪うだけ。元の場所は title で確かめられる
  const name = failure.archive.split(/[\\/]/).pop() ?? failure.archive;

  return (
    <li
      className="flex items-center gap-2 px-2 py-0.5 text-[12.5px]"
      data-testid="failed-item"
      data-archive={failure.archive}
    >
      <AlertTriangle className="size-3.5 shrink-0 text-danger" />
      <span
        className="min-w-0 shrink-0 truncate font-medium"
        data-testid="failed-name"
        title={failure.archive}
      >
        {name}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-ink-muted"
        data-testid="failed-reason"
        title={failure.reason}
      >
        {failure.reason}
      </span>
    </li>
  );
}
