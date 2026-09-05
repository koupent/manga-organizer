import { ChevronUp, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SidecarClient } from "../api/client";
import { Button } from "./ui/button";
import { CardHeader } from "./ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

type Entry = { name: string; path: string; is_directory: boolean };

/** 出力先の指定。直接入力しても、辿って選んでもよい */
export function DirectoryPicker({
  client,
  value,
  onChange,
}: {
  client: SidecarClient;
  value: string;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState<{
    path: string;
    parent: string | null;
  }>({
    path: "",
    parent: null,
  });
  const [entries, setEntries] = useState<Entry[]>([]);

  // 描画のたびに作り直すと、これを切っ掛けにする効果が毎回走る。
  // client は接続できたときに一度作るきりなので、ここで留めておく
  const load = useCallback(
    (path = "") => {
      client.browse(path).then((result) => {
        setLocation({ path: result.path, parent: result.parent ?? null });
        setEntries(
          (result.entries as Entry[]).filter((entry) => entry.is_directory),
        );
      });
    },
    [client],
  );

  // 開いたときに、まだ何も読んでいなければ手で入れてある所から読む。
  // 読み込めた後は location.path が埋まるので、この効果が走り直しても
  // 何もしない。開いている間は重ねて出しているので value も動かない
  useEffect(() => {
    if (open && !location.path) load(value || "");
  }, [open, location.path, load, value]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2">
        <label className="flex min-w-[280px] flex-1 flex-col gap-1">
          <span className="text-[11.5px] font-medium text-ink-muted">
            出力先
          </span>
          <Input
            data-testid="output-directory"
            placeholder="/path/to/整理後"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        <Button
          variant={open ? "primary" : "secondary"}
          data-testid="browse-output"
          onClick={() => setOpen((current) => !current)}
        >
          <FolderOpen />
          参照
        </Button>
      </div>

      {/*
        辿る一覧は設定の列に入る幅が無い。列を広げると処理対象の作業面を
        削ることになるので、選んでいる間だけ重ねて出す。
      */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="output-browser">
          <DialogTitle className="sr-only">出力先を選ぶ</DialogTitle>
          <DialogDescription className="sr-only">
            フォルダを辿って、整理後のファイルを置く場所を決めます。
          </DialogDescription>
          <CardHeader>
            <Button
              variant="ghost"
              data-testid="output-up"
              disabled={!location.parent}
              onClick={() => location.parent && load(location.parent)}
            >
              <ChevronUp />
              上へ
            </Button>
            <code className="max-w-[52ch] truncate rounded bg-canvas px-2 py-0.5 text-[11.5px] text-ink-muted">
              {location.path}
            </code>
            <div className="flex-1" />
            <Button
              variant="primary"
              data-testid="use-this-directory"
              // 読み込み前に押されると出力先が空になってしまう
              disabled={!location.path}
              onClick={() => {
                onChange(location.path);
                setOpen(false);
              }}
            >
              ここを出力先にする
            </Button>
          </CardHeader>
          <ul className="max-h-[50vh] overflow-y-auto p-1">
            {entries.length === 0 ? (
              <li className="px-2 py-3 text-center text-[12px] text-ink-faint">
                この下にフォルダはありません
              </li>
            ) : (
              entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    data-testid="output-entry"
                    data-name={entry.name}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px] hover:bg-surface-2"
                    onClick={() => load(entry.path)}
                  >
                    <Folder className="size-3.5 shrink-0 text-brand/80" />
                    {entry.name}
                  </button>
                </li>
              ))
            )}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
