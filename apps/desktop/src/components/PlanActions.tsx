import { Play, Square, TriangleAlert } from "lucide-react";
import { masterCheckState, type PlanRow } from "../lib/plan";
import { issueLabel } from "./PlanList";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Progress } from "./ui/progress";

type PlanActionsProps = {
  rows: PlanRow[];
  excluded: ReadonlySet<string>;
  /** 整理して出来た本。全体のチェックの三態には数えない（#172） */
  done: { has(id: string): boolean };
  /** 押したら何が起きるか、あるいは押せない理由 */
  status: string;
  /**
   * 状態の行に乗せると出る説明。
   *
   * 状態の行は 1 行に収めるので、書き切れない事情はここへ回す。無ければ
   * 付けない。中身の無い説明を出しても、乗せた利用者を空振りさせるだけ。
   */
  statusTitle?: string;
  /** 残っている本に付いた印の件数。0 件の種類は入っていない */
  issues: { issue: string; count: number }[];
  /** サイドカーが報告した進み具合。総数が 0 の間は件数を出さない */
  progress: { current: number; total: number };
  /**
   * いま処理している 1 件の中の進み（0〜1）。件数だけでは、大きな 1 件の
   * 処理中に進捗が止まって見える（#157）
   */
  partial?: number;
  running: boolean;
  /** 主操作を押せないか。理由は status に出す */
  blocked: boolean;
  onToggleAll: (keep: boolean) => void;
  /**
   * 同じ巻の本が、どの巻も 1 冊以下しか入っていないか（#169）。同じ巻の本が
   * 無ければ null
   */
  oneEach: boolean | null;
  /** 同じ巻を 1 冊ずつに絞る（true）/ 全部入れる（false） */
  onToggleOneEach: (one: boolean) => void;
  onRun: () => void;
  onCancel: () => void;
};

/**
 * 主操作の行。
 *
 * 一覧の直上に置き、全体のチェック・押したら何が起きるか・主操作を 1 行に
 * 収める。左列の底に置いていた頃は、一覧を見てから押す所まで目が画面を
 * 横断していた（#68・#70）。
 */
export function PlanActions({
  rows,
  excluded,
  done,
  status,
  statusTitle,
  issues,
  progress,
  partial = 0,
  running,
  blocked,
  onToggleAll,
  oneEach,
  onToggleOneEach,
  onRun,
  onCancel,
}: PlanActionsProps) {
  const master = masterCheckState(rows, excluded, done);
  const percent =
    progress.total > 0
      ? Math.min(100, ((progress.current + partial) / progress.total) * 100)
      : 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {/* 言葉を添える。チェックだけだと状態の文の飾りに見え、まとめて
            外せることに気づかれない */}
        <label
          className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-ink-muted"
          title="全部の対象をまとめて選ぶ・外す"
        >
          <Checkbox
            data-testid="plan-master-check"
            checked={master}
            disabled={running || rows.length === 0}
            aria-label="全部の対象を選ぶ"
            onCheckedChange={() => onToggleAll(master !== true)}
          />
          すべて
        </label>
        {/* 同じ巻を 1 冊だけ残す既定（#166）を、まとめて掛け直す・外す（#169） */}
        <label
          className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-ink-muted"
          title="入れると、同じ巻の本を 1 冊（入っている中で一番大きい本）だけ残します。外すと、同じ巻の本を全部入れます"
        >
          <Checkbox
            data-testid="plan-one-each"
            checked={oneEach === true}
            disabled={running || oneEach === null}
            aria-label="同じ巻は 1 冊だけ残す"
            onCheckedChange={() => onToggleOneEach(oneEach !== true)}
          />
          同じ巻は 1 冊
        </label>
        <span aria-hidden className="h-3 w-px shrink-0 bg-line" />
        <span
          className="truncate text-[12px] text-ink-muted"
          data-testid="organize-status"
          role="status"
          title={statusTitle}
        >
          {status}
        </span>
        {/* 直せる問題は件数だけ添える。行の側にも同じ印が付いている。
            実行が始まったら消す。もう直せる場面ではない */}
        {running
          ? null
          : issues.map(({ issue, count }) => (
              <Badge
                key={issue}
                tone="warn"
                data-testid="plan-issue-chip"
                data-issue={issue}
              >
                <TriangleAlert className="size-3" />
                {issueLabel(issue)} {count}
              </Badge>
            ))}
        <div className="flex-1" />
        {progress.total > 0 ? (
          <span
            className="tabular shrink-0 whitespace-nowrap text-[12px] text-ink-faint"
            data-testid="progress-count"
          >
            {progress.current} / {progress.total} · {Math.floor(percent)}%
          </span>
        ) : null}
        {running ? (
          <Button variant="danger" data-testid="cancel" onClick={onCancel}>
            <Square />
            中断する
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="lg"
          data-testid="confirm"
          disabled={blocked}
          onClick={onRun}
        >
          <Play />
          この内容で整理する
        </Button>
      </div>
      <Progress data-testid="progress" value={percent} />
    </div>
  );
}
