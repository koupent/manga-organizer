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
  /** 押したら何が起きるか、あるいは押せない理由 */
  status: string;
  /** 残っている本に付いた印の件数。0 件の種類は入っていない */
  issues: { issue: string; count: number }[];
  /** サイドカーが報告した進み具合。総数が 0 の間は件数を出さない */
  progress: { current: number; total: number };
  running: boolean;
  /** 主操作を押せないか。理由は status に出す */
  blocked: boolean;
  onToggleAll: (keep: boolean) => void;
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
  status,
  issues,
  progress,
  running,
  blocked,
  onToggleAll,
  onRun,
  onCancel,
}: PlanActionsProps) {
  const master = masterCheckState(rows, excluded);
  const percent =
    progress.total > 0 ? (progress.current / progress.total) * 100 : 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          data-testid="plan-master-check"
          checked={master}
          disabled={running || rows.length === 0}
          aria-label="全部の対象を選ぶ"
          onCheckedChange={() => onToggleAll(master !== true)}
        />
        <span
          className="truncate text-[12px] text-ink-muted"
          data-testid="organize-status"
          role="status"
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
          <span className="tabular text-[12px] text-ink-faint">
            {progress.current} / {progress.total}
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
