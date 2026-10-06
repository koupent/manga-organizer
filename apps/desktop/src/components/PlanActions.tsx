import { Play, Square, TriangleAlert } from "lucide-react";
import { masterCheckState, type PlanRow } from "../lib/plan";
import { cn } from "../lib/utils";
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
  /**
   * 利用者が直さないと押せないままか（#175）。status を警告として見せる。
   * 灰色の文字のままだと、解析を待っているだけだと取り違える
   */
  warning?: boolean;
  onToggleAll: (keep: boolean) => void;
  /**
   * 同じ巻の本が、どの巻も 1 冊以下しか入っていないか（#169）。同じ巻の本が
   * 無ければ null
   */
  oneEach: boolean | null;
  /** 同じ巻を 1 冊ずつに絞る（true）/ 全部入れる（false） */
  onToggleOneEach: (one: boolean) => void;
  mostImages: boolean | null;
  onToggleMostImages: (only: boolean) => void;
  minimumOnly: boolean;
  minimumImageCount: number;
  onToggleMinimum: (only: boolean) => void;
  onOpenSettings: () => void;
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
  warning = false,
  onToggleAll,
  oneEach,
  onToggleOneEach,
  mostImages,
  onToggleMostImages,
  minimumOnly,
  minimumImageCount,
  onToggleMinimum,
  onOpenSettings,
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
        <span
          className={cn(
            "flex min-w-0 items-center gap-1 text-[12px]",
            warning ? "text-warn" : "text-ink-muted",
          )}
          data-testid="organize-status"
          data-warning={warning || undefined}
          role="status"
          title={statusTitle}
        >
          {warning ? <TriangleAlert className="size-3.5 shrink-0" /> : null}
          <span className="truncate">{status}</span>
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
      <div
        data-testid="plan-selection-rules"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-control bg-surface/70 px-2 py-1.5"
      >
        <span className="text-[11px] text-ink-faint">選択ルール</span>
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
          title="選択中の候補を同じ巻で1冊に絞ります。画像枚数最多を残し、同数なら容量で決めます。外すと全候補を選びます。"
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
        <label
          className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-muted"
          title="同じ巻の全候補から画像枚数が最も多い1冊を選び直します。外すと、その巻の候補をすべて選びます。"
        >
          <Checkbox
            data-testid="plan-most-images"
            checked={mostImages === true}
            disabled={running || mostImages === null}
            onCheckedChange={() => onToggleMostImages(mostImages !== true)}
          />
          同じ巻で画像枚数最多
        </label>
        <label
          className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-muted"
          title="設定した下限未満の本を除外します。枚数が不明な本は除外しません。"
        >
          <Checkbox
            data-testid="plan-minimum-only"
            checked={minimumOnly}
            disabled={running || minimumImageCount === 0}
            onCheckedChange={() => onToggleMinimum(!minimumOnly)}
          />
          下限以上のみ
          {minimumImageCount > 0
            ? `（${minimumImageCount}枚）`
            : "（制限なし）"}
        </label>
        <button
          type="button"
          data-testid="plan-image-settings"
          className="text-[11px] text-brand underline underline-offset-2"
          onClick={onOpenSettings}
        >
          画像枚数の下限は設定で変更
        </button>
      </div>
      <Progress data-testid="progress" value={percent} />
    </div>
  );
}
