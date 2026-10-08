import { useEffect, useState, type ReactNode } from "react";
import {
  sidecarReason,
  type SidecarClient,
  type MarginRequest,
} from "../api/client";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { EditorLayout } from "./EditorLayout";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

type Scan = {
  token: string;
  margins: MarginRequest["margins"];
  pages: { name: string; width: number; height: number; margins: number[] }[];
};

/** 保存済みのページをまとめて切る。設定と選択はモードを離れても保持する。 */
export function MarginEditor({
  client,
  archive,
  active,
  generation,
  modes,
  onSaved,
  onBusy,
}: {
  client: SidecarClient;
  archive: string;
  active: boolean;
  generation: number;
  modes: ReactNode;
  onSaved: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [margins, setMargins] = useState<MarginRequest["margins"]>([
    0, 0, 0, 0,
  ]);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanGeneration, setScanGeneration] = useState(-1);
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState<string | null>(null);
  useEffect(() => {
    if (!active || scanGeneration === generation) return;
    let alive = true;
    let jobId: string | null = null;
    const controller = new AbortController();
    setBusy(true);
    onBusy(true);
    setMessage("全ページの共通余白を調べています…");
    void (async () => {
      try {
        const accepted = await client.marginScan(archive);
        jobId = accepted.id;
        if (!alive) {
          await client.cancelJob(jobId);
          return;
        }
        const job = await client.waitForJob(
          jobId,
          (progress) => {
            if (alive)
              setMessage(
                `共通余白を調べています ${progress.current} / ${progress.total}`,
              );
          },
          { signal: controller.signal },
        );
        jobId = null;
        if (!alive) return;
        if (job.state !== "succeeded")
          throw new Error(job.error ?? "余白を調べられませんでした");
        const result = job.result as Scan;
        setScan(result);
        setMargins(result.margins);
        setSelected(result.pages.map((page) => page.name));
        setScanGeneration(generation);
        setMessage(
          result.margins.some((value) => value > 0)
            ? "共通余白を提案しました。枠と対象ページを確認して保存してください。"
            : "共通する白い余白は見つかりませんでした。切り取り量を手動で指定できます。",
        );
      } catch (error) {
        if (alive) setMessage(sidecarReason(error));
      } finally {
        if (alive) {
          setBusy(false);
          onBusy(false);
        }
      }
    })();
    return () => {
      alive = false;
      controller.abort();
      if (jobId) void client.cancelJob(jobId).catch(() => undefined);
    };
  }, [active, archive, client, generation, scanGeneration, retry, onBusy]);

  const save = async () => {
    if (!scan || busy) return;
    setBusy(true);
    onBusy(true);
    setMessage("余白カットを保存しています…");
    try {
      const accepted = await client.trimMargins({
        archive,
        token: scan.token,
        names: selected,
        margins,
      });
      const job = await client.waitForJob(accepted.id);
      if (job.state !== "succeeded")
        throw new Error(job.error ?? "保存に失敗しました");
      setMessage(`${selected.length} ページの余白をカットしました`);
      onSaved();
    } catch (error) {
      setMessage(sidecarReason(error));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  if (!active) return null;
  const valid =
    margins.some((value) => value > 0) &&
    margins.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 40,
    );
  return (
    <EditorLayout
      toolbar={
        <>
          <span className="shrink-0 text-[11px] text-ink-faint">
            モード選択
          </span>
          {modes}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setScanGeneration(-1);
              setRetry((value) => value + 1);
            }}
          >
            余白を再検出
          </Button>
          <span className="flex-1" />
          <Button
            data-testid="margin-save"
            disabled={busy || !scan || !selected.length || !valid}
            onClick={() => void save()}
          >
            余白カットを保存
          </Button>
        </>
      }
      hint="全ページに同じ割合で適用します。白い縁から共通の余白を推定します。自動判定は保存前に確認してください。"
    >
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
        {["左", "上", "右", "下"].map((label, index) => (
          <label key={label} className="flex items-center gap-1">
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
              className="w-16 rounded border border-line bg-surface-1 px-2 py-1"
              onChange={(event) => {
                const next: MarginRequest["margins"] = [...margins];
                next[index] = Number(event.target.value);
                setMargins(next);
              }}
            />
            %
          </label>
        ))}
        <Button
          variant="secondary"
          disabled={busy || !scan}
          onClick={() =>
            setSelected(scan?.pages.map((page) => page.name) ?? [])
          }
        >
          全ページを選択
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setSelected([])}>
          選択を解除
        </Button>
        <span>{selected.length} ページ選択</span>
      </div>
      <p
        role="status"
        data-testid="margin-status"
        className="mb-2 text-xs text-ink-muted"
      >
        {message}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
          }}
        >
          {scan?.pages.map((page, index) => (
            <div
              key={page.name}
              data-testid="margin-card"
              className="overflow-hidden rounded border border-line bg-surface-1"
            >
              <button
                type="button"
                aria-label={`${index + 1} ページを大きく表示`}
                className="relative block w-full"
                onClick={() => setZoom(page.name)}
              >
                <img
                  alt={`${index + 1} ページ`}
                  src={`${client.thumbnailUrl(archive, page.name, 400)}&v=${generation}`}
                  className="block w-full"
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute border-2 border-brand bg-brand/5"
                  style={{
                    left: `${margins[0]}%`,
                    top: `${margins[1]}%`,
                    right: `${margins[2]}%`,
                    bottom: `${margins[3]}%`,
                  }}
                />
              </button>
              <label className="flex items-center justify-between gap-2 px-2 py-2 text-xs">
                <span>
                  {index + 1} · {page.width} × {page.height}
                </span>
                <Checkbox
                  aria-label={`${index + 1} ページを切り取る`}
                  disabled={busy}
                  checked={selected.includes(page.name)}
                  onCheckedChange={(checked) =>
                    setSelected(
                      checked
                        ? [...selected, page.name]
                        : selected.filter((name) => name !== page.name),
                    )
                  }
                />
              </label>
            </div>
          ))}
        </div>
      </div>
      <Dialog
        open={zoom !== null}
        onOpenChange={(open) => {
          if (!open) setZoom(null);
        }}
      >
        <DialogContent className="flex max-h-[95vh] max-w-[95vw] flex-col items-center">
          <DialogTitle>切り取り範囲の確認</DialogTitle>
          <Button variant="secondary" onClick={() => setZoom(null)}>
            閉じる
          </Button>
          {zoom && (
            <div className="relative min-h-0">
              <img
                alt="切り取り範囲の確認"
                src={`${client.imageUrl(archive, zoom)}&v=${generation}`}
                className="max-h-[80vh] max-w-[90vw] object-contain"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute border-2 border-brand"
                style={{
                  left: `${margins[0]}%`,
                  top: `${margins[1]}%`,
                  right: `${margins[2]}%`,
                  bottom: `${margins[3]}%`,
                }}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </EditorLayout>
  );
}
