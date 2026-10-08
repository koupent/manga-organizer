import { useEffect, useState } from "react";
import {
  sidecarReason,
  type SidecarClient,
  type MarginRequest,
} from "../api/client";
import { Button } from "./ui/button";

type Scan = {
  token: string;
  margins: MarginRequest["margins"];
  pages: {
    name: string;
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
  const [busy, setBusy] = useState(false);
  const [scanGeneration, setScanGeneration] = useState(-1);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active || scanGeneration === generation) return;
    let alive = true;
    let jobId: string | null = null;
    const controller = new AbortController();
    setBusy(true);
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
        }
      }
    })();
    return () => {
      alive = false;
      controller.abort();
      if (jobId) void client.cancelJob(jobId).catch(() => undefined);
    };
  }, [active, archive, client, generation, scanGeneration, retry]);

  const restorable = selected.filter((name) =>
    scan?.pages.some((page) => page.name === name && page.restorable),
  );
  const save = async (restore = false) => {
    if (!scan || busy) return;
    setBusy(true);
    setMessage(
      restore
        ? "切り取り前の画像に戻しています…"
        : "余白カットを保存しています…",
    );
    try {
      const request = {
        archive,
        token: scan.token,
        names: restore ? restorable : selected,
      };
      const accepted = restore
        ? await client.restoreMargins(request)
        : await client.trimMargins({ ...request, margins });
      const job = await client.waitForJob(accepted.id);
      if (job.state !== "succeeded")
        throw new Error(job.error ?? "保存に失敗しました");
      setMessage(
        restore
          ? `${restorable.length} ページを切り取り前に戻しました`
          : `${selected.length} ページの余白をカットしました`,
      );
      onSaved();
    } catch (error) {
      setMessage(sidecarReason(error));
    } finally {
      setBusy(false);
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
    setMargins,
    selected,
    setSelected,
    message,
    busy,
    canSave: !busy && !!scan && selected.length > 0 && valid,
    restorableCount: restorable.length,
    save,
    rescan: () => {
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
  const { scan, margins, setMargins, selected, setSelected, busy } = job;
  return (
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
        onClick={() => setSelected(scan?.pages.map((page) => page.name) ?? [])}
      >
        全ページを選択
      </Button>
      <Button variant="ghost" disabled={busy} onClick={() => setSelected([])}>
        選択を解除
      </Button>
      <span>{selected.length} ページ選択</span>
    </div>
  );
}
