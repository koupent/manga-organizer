import { ChevronUp, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SidecarClient } from "../api/client";
import { sidecarReason } from "../api/client";
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

/**
 * 打ち終わったとみなすまでの待ち時間。
 *
 * 打つそばから覚えさせると、`D:\manga` を打つ途中の `D:\` まで出力先として
 * 覚え、ドライブ丸ごとが書き出してよい場所になってしまう。
 */
const TYPING_SETTLED_MS = 500;

/** 出力先の指定。直接入力しても、辿って選んでもよい */
export function DirectoryPicker({
  client,
  value,
  onChange,
  label = "出力先",
  onOpenSettings,
}: {
  client: SidecarClient;
  value: string;
  onChange: (path: string) => void;
  label?: string;
  onOpenSettings?: () => void;
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
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const browseRequest = useRef(0);

  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 選んだ場所をサイドカーへ伝える。
   *
   * サイドカーは覚えのある場所へしか書き出さない。伝えるのはこの「利用者が
   * 出力先を決めた」操作の中だけで、実行のときにまとめて伝えることはしない。
   * 実行時に伝えると、整理の依頼が自分の許可を連れてくる形になり、覚えが
   * 何も守らなくなる。
   */
  const remember = useCallback(
    (path: string) => {
      if (!path.trim()) return;
      // 覚えられなかったことはここでは知らせない。実行したときにサイドカーが
      // 理由付きで断り、その文言が実行の状態欄に出る
      client.chooseOutputRoot(path).catch(() => undefined);
    },
    [client],
  );

  // 打っている途中で画面を離れたときに、遅れて覚えさせない
  useEffect(
    () => () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
    },
    [],
  );

  // 描画のたびに作り直すと、これを切っ掛けにする効果が毎回走る。
  // client は接続できたときに一度作るきりなので、ここで留めておく
  const load = useCallback(
    (path = "") => {
      const request = ++browseRequest.current;
      setError("");
      client
        .browse(path)
        .then((result) => {
          if (request !== browseRequest.current) return;
          setLocation({ path: result.path, parent: result.parent ?? null });
          setAddress(result.path);
          setEntries(
            (result.entries as Entry[]).filter((entry) => entry.is_directory),
          );
        })
        .catch((reason) => {
          if (request === browseRequest.current)
            setError(sidecarReason(reason));
        });
    },
    [client],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2">
        <label className="flex min-w-[280px] flex-1 flex-col gap-1">
          <span className="text-[11.5px] font-medium text-ink-muted">
            {label}
          </span>
          <Input
            data-testid="output-directory"
            placeholder="最初に入れたものの場所が入ります"
            value={value}
            onChange={(event) => {
              const path = event.target.value;
              onChange(path);
              if (typingTimer.current) clearTimeout(typingTimer.current);
              typingTimer.current = setTimeout(
                () => remember(path),
                TYPING_SETTLED_MS,
              );
            }}
          />
        </label>
        <Button
          variant={open ? "primary" : "secondary"}
          data-testid="browse-output"
          onClick={() => {
            if (!open) load(value || "");
            setOpen((current) => !current);
          }}
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
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (address.trim()) load(address.trim());
              }}
            >
              <Input
                aria-label="フォルダのパスを入力"
                data-testid="output-browser-path"
                placeholder="パスを入力して Enter"
                value={address}
                onChange={(event) => {
                  // 入力中に、開いた直後の読み込み結果でパスを上書きしない。
                  browseRequest.current += 1;
                  setAddress(event.target.value);
                }}
              />
              <Button type="submit" disabled={!address.trim()}>
                移動
              </Button>
            </form>
            <div className="flex-1" />
            <Button
              variant="primary"
              data-testid="use-this-directory"
              // 読み込み前に押されると出力先が空になってしまう
              disabled={!location.path || address !== location.path || !!error}
              onClick={() => {
                onChange(location.path);
                // 押した時点で決まりきっているので、待たずに伝える
                remember(location.path);
                setOpen(false);
              }}
            >
              ここを出力先にする
            </Button>
          </CardHeader>
          <p className="text-[11.5px] text-ink-muted">
            上の欄にフォルダのパスを入力して、Enter または「移動」で開けます。
          </p>
          {error ? (
            <p role="alert" className="text-[12px] text-danger">
              {error}
            </p>
          ) : null}
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
          {onOpenSettings ? (
            <Button
              variant="ghost"
              data-testid="output-default-settings"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              デフォルトの出力先を設定する
            </Button>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
