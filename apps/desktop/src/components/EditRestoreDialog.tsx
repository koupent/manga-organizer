import { useEffect, useState } from "react";
import {
  sidecarReason,
  type SidecarClient,
  type RestoreMode,
  type RestorePreview,
} from "../api/client";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";

const LABELS: Record<RestoreMode, string> = {
  all: "すべての編集",
  trim: "余白カット",
  split: "ページ分割",
  merge: "ページ結合",
  thumbnail: "サムネイルの画像加工",
};

export function EditRestoreDialog({
  client,
  archive,
  mode,
  onClose,
  onRestored,
  onBusy,
}: {
  client: SidecarClient;
  archive: string;
  mode: RestoreMode;
  onClose: () => void;
  onRestored: (result: RestorePreview) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void client
      .restorePreview(archive, mode)
      .then((result) => {
        if (alive) setPreview(result);
      })
      .catch((error) => {
        if (alive) setError(sidecarReason(error));
      });
    return () => {
      alive = false;
    };
  }, [client, archive, mode]);
  const canRestore =
    preview &&
    (preview.complete ||
      Object.values(preview.counts).some((count) => count > 0));
  const restore = async () => {
    if (!canRestore || busy) return;
    setBusy(true);
    onBusy?.(true);
    setError("");
    try {
      const accepted = await client.restoreSaved(archive, mode);
      const job = await client.waitForJob(accepted.id);
      if (job.state !== "succeeded")
        throw new Error(job.error ?? "復元できませんでした");
      onRestored(job.result as RestorePreview);
      onClose();
    } catch (error) {
      setError(sidecarReason(error));
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        data-testid="edit-reset-dialog"
        className="w-[min(32rem,92vw)] gap-3 p-4"
      >
        <DialogTitle className="font-semibold">
          {LABELS[mode]}を戻す
        </DialogTitle>
        <DialogDescription>
          {archive.split(/[\\/]/).pop()}{" "}
          の保存済み編集を復元します。未保存の変更は破棄されます。ファイル名と保存場所は維持します。
        </DialogDescription>
        {preview ? (
          <>
            <p className="text-sm">{preview.message}</p>
            {Object.entries(preview.counts).map(([kind, count]) => (
              <p key={kind} className="text-xs">
                {LABELS[kind as RestoreMode]}：{count} 件
              </p>
            ))}
            {!canRestore ? (
              <p role="status" className="text-sm text-ink-muted">
                復元できる元画像がありません。記録のない旧版の編集は元のファイルが必要です。
              </p>
            ) : (
              <p className="text-xs text-ink-muted">
                復元を実行した後は取り消せません。
              </p>
            )}
          </>
        ) : (
          <p role="status">
            {error
              ? "復元可否を確認できませんでした"
              : "復元できる編集を調べています…"}
          </p>
        )}
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        {busy ? <p role="status">保存済みの元画像から復元しています…</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            やめる
          </Button>
          <Button
            variant="danger"
            data-testid="edit-reset-confirm"
            disabled={!canRestore || busy}
            onClick={() => void restore()}
          >
            {mode === "all" && preview?.complete
              ? "すべて元に戻す"
              : "復元できる編集を戻す"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
