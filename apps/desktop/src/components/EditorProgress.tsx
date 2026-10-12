import { Loader2 } from "lucide-react";
import { Progress } from "./ui/progress";

/** モードに関係なく、処理中は作業面に同じ表示を重ねる。 */
export function EditorProgress({
  title,
  description = "処理が終わるまでお待ちください。",
  progress,
  testId = "editor-progress",
  progressLabel = "編集の進捗",
}: {
  title: string;
  description?: string;
  progress?: { current: number; total: number };
  testId?: string;
  progressLabel?: string;
}) {
  const { current, total } = progress ?? { current: 0, total: 0 };
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <div
      data-testid={testId}
      className="absolute inset-0 z-20 flex items-center justify-center bg-canvas/80 p-4"
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-md rounded-card border border-brand/50 bg-surface p-6 shadow-xl">
        <div className="mb-3 flex items-center gap-3 text-lg font-semibold">
          <Loader2 className="size-6 shrink-0 animate-spin text-brand" />
          {title}
        </div>
        <p className="mb-4 text-sm text-ink-muted">{description}</p>
        {progress ? (
          <>
            <div className="mb-2 flex justify-between text-sm tabular">
              <span>
                {total > 0
                  ? `${current} / ${total} ページ`
                  : "処理を準備しています…"}
              </span>
              <span>{total > 0 ? `${percent}%` : ""}</span>
            </div>
            <Progress
              aria-label={progressLabel}
              value={percent}
              className="h-2"
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
