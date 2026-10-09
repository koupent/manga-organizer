import { useEffect, useRef, useState } from "react";
import {
  sidecarReason,
  type SidecarClient,
  type MarginRequest,
} from "../api/client";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Progress } from "./ui/progress";
import { Loader2, SlidersHorizontal, X } from "lucide-react";

type Scan = {
  token: string;
  margins: MarginRequest["margins"];
  pages: {
    name: string;
    hash: string;
    width: number;
    height: number;
    margins: number[];
    restorable: boolean;
  }[];
};

/** 余白の走査・選択・保存。ページの表示は共通の一覧に任せる。 */
export function useMarginJob({
  client,
  archive,
  active,
  generation,
  onSaved,
}: {
  client: SidecarClient;
  archive: string;
  active: boolean;
  generation: number;
  onSaved: () => void;
}) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [margins, setMargins] = useState<MarginRequest["margins"]>([
    0, 0, 0, 0,
  ]);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<"scan" | "refresh" | "save" | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState(false);
  const busy = phase !== null;
  const [scanGeneration, setScanGeneration] = useState(-1);
  const [retry, setRetry] = useState(0);
  const [needsDetection, setNeedsDetection] = useState(false);
  const [history, setHistory] = useState<
    { margins: MarginRequest["margins"]; selected: string[] }[]
  >([]);
  const remember = () =>
    setHistory((items) => [...items, { margins, selected }].slice(-100));
  const previous = useRef({ scan, selected });
  previous.current = { scan, selected };
  useEffect(() => {
    if (!active || scanGeneration === generation) return;
    let alive = true;
    let jobId: string | null = null;
    const controller = new AbortController();
    const { scan, selected } = previous.current;
    const detect = scan === null;
    setPhase(detect ? "scan" : "refresh");
    setProgress({ current: 0, total: 0 });
    setError(false);
    setMessage("全ページの共通余白を調べています…");
    void (async () => {
      try {
        const accepted = await client.marginScan(archive, detect);
        jobId = accepted.id;
        if (!alive) {
          await client.cancelJob(jobId);
          return;
        }
        const job = await client.waitForJob(
          jobId,
          (progress) => {
            if (alive) {
              setProgress({ current: progress.current, total: progress.total });
              setMessage(
                `共通余白を調べています ${progress.current} / ${progress.total}`,
              );
            }
          },
          { signal: controller.signal },
        );
        jobId = null;
        if (!alive) return;
        if (job.state !== "succeeded")
          throw new Error(job.error ?? "余白を調べられませんでした");
        const result = job.result as Scan;
        setScan(
          detect
            ? result
            : {
                ...result,
                margins: scan?.margins ?? result.margins,
                pages: result.pages.map((page) => ({
                  ...page,
                  margins:
                    scan?.pages.find((old) => old.hash === page.hash)
                      ?.margins ?? page.margins,
                })),
              },
        );
        setNeedsDetection(
          !detect &&
            result.pages.some(
              (page) => !scan?.pages.some((old) => old.hash === page.hash),
            ),
        );
        if (detect) {
          setMargins(result.margins);
          setSelected(result.pages.map((page) => page.name));
        } else {
          const selectedHashes = new Set(
            scan?.pages
              .filter((page) => selected.includes(page.name))
              .map((page) => page.hash),
          );
          setSelected(
            result.pages
              .filter((page) => selectedHashes.has(page.hash))
              .map((page) => page.name),
          );
        }
        setScanGeneration(generation);
        if (detect)
          setMessage(
            result.margins.some((value) => value > 0)
              ? "共通余白を提案しました。枠と対象ページを確認して保存してください。"
              : "共通する白い余白は見つかりませんでした。切り取り量を手動で指定できます。",
          );
      } catch (error) {
        if (alive) {
          setError(true);
          setMessage(sidecarReason(error));
        }
      } finally {
        if (alive) {
          setPhase(null);
        }
      }
    })();
    return () => {
      alive = false;
      controller.abort();
      if (jobId) void client.cancelJob(jobId).catch(() => undefined);
    };
  }, [active, archive, client, generation, scanGeneration, retry]);

  const save = async () => {
    if (!scan || busy) return;
    setPhase("save");
    setProgress({ current: 0, total: 0 });
    setError(false);
    setMessage("余白カットを保存しています…");
    try {
      const request = {
        archive,
        token: scan.token,
        names: selected,
      };
      const accepted = await client.trimMargins({ ...request, margins });
      const job = await client.waitForJob(accepted.id, (progress) =>
        setProgress({ current: progress.current, total: progress.total }),
      );
      if (job.state !== "succeeded")
        throw new Error(job.error ?? "保存に失敗しました");
      setMessage(`${selected.length} ページの余白をカットしました`);
      setHistory([]);
      onSaved();
    } catch (error) {
      setError(true);
      setMessage(sidecarReason(error));
    } finally {
      setPhase(null);
    }
  };
  const valid =
    margins.some((value) => value > 0) &&
    margins.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 40,
    );
  return {
    scan,
    margins,
    setMargins: (next: MarginRequest["margins"]) => {
      remember();
      setMargins(next);
    },
    selected,
    setSelected: (next: string[]) => {
      remember();
      setSelected(next);
    },
    history,
    needsDetection,
    undo: () => {
      const prior = history.at(-1);
      if (!prior || busy) return;
      setMargins(prior.margins);
      setSelected(prior.selected);
      setHistory(history.slice(0, -1));
    },
    discard: () => {
      if (busy) return;
      setMargins(scan?.margins ?? [0, 0, 0, 0]);
      setSelected([]);
      setHistory([]);
    },
    message,
    busy,
    phase,
    progress,
    error,
    canSave: !busy && !!scan && selected.length > 0 && valid,
    save,
    rescan: () => {
      setScan(null);
      setScanGeneration(-1);
      setRetry((value) => value + 1);
    },
  };
}

export function MarginControls({
  job,
}: {
  job: ReturnType<typeof useMarginJob>;
}) {
  const [open, setOpen] = useState(false);
  const { margins, setMargins, busy } = job;
  return (
    <>
      <Button
        variant="secondary"
        className="shrink-0"
        data-testid="margin-settings"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal /> 切り取り量
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-testid="margin-settings-dialog"
          className="w-[min(28rem,92vw)] gap-4"
        >
          <div className="flex items-center justify-between">
            <DialogTitle className="font-semibold">
              余白カットの調整
            </DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              aria-label="調整を閉じる"
              onClick={() => setOpen(false)}
            >
              <X />
            </Button>
          </div>
          <DialogDescription className="text-sm text-ink-muted">
            各辺から切り取る割合を、チェックしたページへ一律に適用します。
          </DialogDescription>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {["左", "上", "右", "下"].map((label, index) => (
              <label key={label} className="flex items-center gap-2">
                {label}
                <input
                  aria-label={`${label}の切り取り量（%）`}
                  data-testid={`margin-${index}`}
                  type="number"
                  min="0"
                  max="40"
                  step="0.1"
                  disabled={busy}
                  value={margins[index]}
                  className="w-20 rounded border border-line bg-surface-1 px-2 py-1"
                  onChange={(event) => {
                    const next: MarginRequest["margins"] = [...margins];
                    next[index] = Number(event.target.value);
                    setMargins(next);
                  }}
                />{" "}
                %
              </label>
            ))}
          </div>
          <Button variant="primary" onClick={() => setOpen(false)}>
            範囲を一覧で確認
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 一覧を押し下げず、検出・書き込み中であることを作業面に重ねて伝える。 */
export function MarginProgress({
  job,
}: {
  job: ReturnType<typeof useMarginJob>;
}) {
  if (!job.busy || job.phase === "refresh") return null;
  const { current, total } = job.progress;
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <div
      data-testid="margin-progress"
      className="absolute inset-0 z-20 flex items-center justify-center bg-canvas/80 p-4"
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-md rounded-card border border-brand/50 bg-surface p-6 shadow-xl">
        <div className="mb-3 flex items-center gap-3 text-lg font-semibold">
          <Loader2 className="size-6 shrink-0 animate-spin text-brand" />
          {job.phase === "scan"
            ? "全ページの余白を検出しています"
            : "余白カットを反映しています"}
        </div>
        <p className="mb-4 text-sm text-ink-muted">
          {job.phase === "scan"
            ? "共通する白い余白を調べています。完了後、切り取り範囲を一覧に表示します。"
            : "処理が終わるまでお待ちください。"}
        </p>
        <div className="mb-2 flex justify-between text-sm tabular">
          <span>
            {total > 0
              ? `${current} / ${total} ページ`
              : "処理を準備しています…"}
          </span>
          <span>{total > 0 ? `${percent}%` : ""}</span>
        </div>
        <Progress
          aria-label="余白カットの進捗"
          value={percent}
          className="h-2"
        />
      </div>
    </div>
  );
}
