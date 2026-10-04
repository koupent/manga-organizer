import { RefreshCw, Settings, X } from "lucide-react";
import { useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "../connection";
import { findUpdate } from "./UpdateNotice";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";

type Check =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "latest" }
  | { state: "found"; version: string }
  | { state: "failed"; reason: string };

type SettingsDialogProps = {
  /** 新しい版が見つかった。画面上部の案内を出し直す */
  onUpdateFound: (update: Update) => void;
};

/**
 * 設定（#136）。普段は見なくてよいものを、作業の画面から外してここに置く。
 *
 * いまは版の確認だけ。起動時の更新の案内を「あとで」で閉じたあとも、
 * アプリを開いたまま確かめ直せるようにする。
 */
export function SettingsDialog({ onUpdateFound }: SettingsDialogProps) {
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const desktop = isTauri();

  const checkForUpdate = async () => {
    setCheck({ state: "checking" });
    try {
      const found = await findUpdate();
      if (!found) {
        setCheck({ state: "latest" });
        return;
      }
      setCheck({ state: "found", version: found.version });
      onUpdateFound(found);
    } catch (reason) {
      setCheck({
        state: "failed",
        reason: String((reason as Error)?.message ?? reason),
      });
    }
  };

  return (
    <Dialog
      // 開き直したときに前回の結果を出し続けない。古い「最新の版です」は嘘になる
      onOpenChange={(open) => {
        if (open) setCheck({ state: "idle" });
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-testid="open-settings"
          aria-label="設定"
          title="設定"
        >
          <Settings />
        </Button>
      </DialogTrigger>
      <DialogContent
        data-testid="settings-dialog"
        className="w-[min(28rem,92vw)] gap-3"
      >
        <div className="flex items-center justify-between">
          <DialogTitle className="text-[13.5px] font-semibold">
            設定
          </DialogTitle>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="設定を閉じる"
              title="設定を閉じる"
            >
              <X />
            </Button>
          </DialogClose>
        </div>
        <DialogDescription className="sr-only">
          アプリの版を確かめ、新しい版があるか確認できます。
        </DialogDescription>

        <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3">
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-ink-faint">アプリの版</span>
            <span
              className="tabular text-[13px] font-semibold"
              data-testid="app-version"
            >
              v{__APP_VERSION__}
            </span>
            <div className="flex-1" />
            <Button
              variant="secondary"
              data-testid="check-update"
              disabled={!desktop || check.state === "checking"}
              onClick={() => void checkForUpdate()}
            >
              <RefreshCw />
              更新を確認
            </Button>
          </div>
          <p
            role="status"
            data-testid="update-check-status"
            className="min-h-[18px] text-[12px] text-ink-muted"
          >
            {!desktop
              ? "ブラウザで開いているときは確認できません"
              : check.state === "checking"
                ? "確認しています..."
                : check.state === "latest"
                  ? "最新の版です"
                  : check.state === "found"
                    ? `新しい版 v${check.version} があります。画面上部の案内から更新できます`
                    : check.state === "failed"
                      ? `確認できませんでした: ${check.reason}`
                      : ""}
          </p>
        </section>
      </DialogContent>
    </Dialog>
  );
}
