import { Download, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "../connection";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

type Phase = "offered" | "downloading" | "installing" | "failed";

/**
 * 新しい版を知らせ、利用者が受け入れたら入れ替える。
 *
 * 起動したときに 1 回だけ確かめる。配布用の公開リポジトリの latest.json を
 * 読み、署名を確かめてから入れ替えるのは updater プラグイン。Windows では
 * インストーラを起こした時点でアプリが閉じ、入れ替わった版が起ち上がり直す。
 * ブラウザ（開発と e2e）では何もしない。
 */
export function UpdateNotice() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>("offered");
  const [received, setReceived] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    import("@tauri-apps/plugin-updater")
      .then(({ check }) => check())
      .then((found) => {
        if (!cancelled && found) setUpdate(found);
      })
      // 確かめられなくても今の版は使い続けられる。オフラインのたびに
      // 失敗を知らせても、利用者にできることが無い
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update) return null;

  const apply = async () => {
    setPhase("downloading");
    setError("");
    let sidecarStopped = false;
    try {
      let done = 0;
      await update.download((event) => {
        if (event.event === "Started") {
          setReceived({ done: 0, total: event.data.contentLength ?? 0 });
        } else if (event.event === "Progress") {
          done += event.data.chunkLength;
          setReceived((current) => ({ ...current, done }));
        }
      });
      setPhase("installing");
      // インストーラがサイドカーの実行ファイルを上書きできるよう、先に止める。
      // 落とし終わるまでは止めない（落とせなかったら使い続けられるように）
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("stop_sidecar");
      sidecarStopped = true;
      // Windows ではここでアプリが閉じ、インストーラが入れ替えて起ち上げ直す
      await update.install();
    } catch (reason) {
      setPhase("failed");
      const message = String((reason as Error)?.message ?? reason);
      setError(
        sidecarStopped ? `${message}（アプリを起動し直してください）` : message,
      );
    }
  };

  const percent =
    received.total > 0 ? Math.round((received.done / received.total) * 100) : 0;

  return (
    <Alert
      tone={phase === "failed" ? "danger" : "info"}
      data-testid="update-notice"
    >
      {phase === "failed" ? <TriangleAlert /> : <Download />}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-ink">
          新しい版 v{update.version} があります（今は v{update.currentVersion}）
        </span>
        {update.body ? (
          <details className="text-[12px]">
            <summary className="cursor-pointer select-none">変更点</summary>
            <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap">
              {update.body}
            </p>
          </details>
        ) : null}
        {phase === "downloading" ? (
          <span className="tabular text-[12px]">ダウンロード中 {percent}%</span>
        ) : null}
        {phase === "installing" ? (
          <span className="text-[12px]">
            インストーラを起動します。アプリはいったん閉じ、終わると起ち上がり直します
          </span>
        ) : null}
        {phase === "failed" ? (
          <span className="text-[12px]">更新できませんでした: {error}</span>
        ) : null}
      </div>
      {phase === "offered" || phase === "failed" ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="primary" onClick={() => void apply()}>
            <RefreshCw />
            更新する
          </Button>
          <Button variant="ghost" onClick={() => setUpdate(null)}>
            あとで
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}
