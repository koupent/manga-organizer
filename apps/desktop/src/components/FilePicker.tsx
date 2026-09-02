import {
  ChevronUp,
  Folder,
  FolderOpen,
  Package,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardHeader } from "./ui/card";
import { Empty } from "./ui/empty";
import type { SidecarClient } from "../api/client";

type Entry = { name: string; path: string; is_directory: boolean };

type FilePickerProps = {
  client: SidecarClient;
  selected: string[];
  onChange: (paths: string[]) => void;
};

/**
 * 処理対象の選択。
 *
 * 元の Tkinter 版と同じく、まとめて放り込んで一覧で確認する形にする。
 * ブラウザはドロップされたファイルの実パスを取得できないため、
 * サーバー側を辿って選ぶ経路も用意する。Tauri ではネイティブのドロップが
 * 実パスを届けるので、そちらも同じ一覧へ入る。
 */
export function FilePicker({ client, selected, onChange }: FilePickerProps) {
  const [browsing, setBrowsing] = useState(false);
  const [location, setLocation] = useState<{ path: string; parent: string | null }>({
    path: "",
    parent: null,
  });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const load = (path = "") => {
    client
      .browse(path)
      .then((result) => {
        setLocation({ path: result.path, parent: result.parent ?? null });
        setEntries(result.entries as Entry[]);
        setError("");
      })
      .catch((reason) => setError(String(reason.message ?? reason)));
  };

  useEffect(() => {
    if (browsing && !location.path) load();
  }, [browsing]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (paths: string[]) => {
    onChange([...new Set([...selected, ...paths])]);
  };

  /**
   * ドロップから実パスを取り出す。
   *
   * VS Code のエクスプローラーや Linux のファイルマネージャは
   * text/uri-list に file:// の URI を載せてくる。取れる場合はそれが確実。
   */
  const pathsFromTransfer = (transfer: DataTransfer): string[] => {
    const raw =
      transfer.getData("text/uri-list") || transfer.getData("text/plain") || "";
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        if (!line.startsWith("file://")) return line.startsWith("/") ? line : "";
        try {
          return decodeURIComponent(new URL(line).pathname);
        } catch {
          return "";
        }
      })
      .filter(Boolean);
  };

  /**
   * ドロップを受ける。
   *
   * まず実パスが載っていればそれを使う。載っていない場合（多くのブラウザ）は
   * 名前とサイズを手がかりに、許可された場所の中から探して結びつける。
   * Tauri のネイティブなドロップは実パスが直接届くので、App が処理する。
   */
  const handleDrop = async (transfer: DataTransfer) => {
    const direct = pathsFromTransfer(transfer);
    if (direct.length > 0) {
      add(direct);
      setError("");
      return;
    }

    const dropped = Array.from(transfer.files).map((file) => ({
      name: file.name,
      size: file.size,
    }));
    if (dropped.length === 0) {
      setError(
        "ドロップされた内容からファイルを取り出せませんでした。" +
          "「ファイルを選ぶ」から辿ってください",
      );
      return;
    }
    setError("");
    try {
      const result = await client.resolveDropped(dropped);
      if (result.resolved.length > 0) add(result.resolved);
      const problems: string[] = [];
      if (result.unresolved.length > 0) {
        const roots = (result.searched_roots ?? []).join(" / ") || "(制限なし)";
        problems.push(
          `見つかりません: ${result.unresolved.join(", ")}` +
            `（探した場所: ${roots}。この中に無いファイルは扱えません）`,
        );
      }
      if (result.ambiguous.length > 0) {
        problems.push(
          `同名が複数あるため特定できません: ${result.ambiguous.join(", ")}`,
        );
      }
      setError(problems.join(" / "));
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const addFolder = (folder: Entry) => {
    client
      .browse(folder.path)
      .then((result) =>
        add(
          (result.entries as Entry[])
            .filter((entry) => !entry.is_directory)
            .map((entry) => entry.path),
        ),
      )
      .catch((reason) => setError(String(reason.message ?? reason)));
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-semibold">処理対象</h2>
        <span className="tabular text-[12px] text-ink-faint" data-testid="selected-count">
          {selected.length} 件
        </span>
        <div className="flex-1" />
        <Button
          variant={browsing ? "primary" : "secondary"}
          size="sm"
          data-testid="open-browser"
          onClick={() => setBrowsing((open) => !open)}
        >
          <FolderOpen />
          {browsing ? "選択を閉じる" : "ファイルを選ぶ"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="clear-selection"
          disabled={selected.length === 0}
          onClick={() => onChange([])}
        >
          一覧を空にする
        </Button>
      </div>

      <div
        className={cn(
          "rounded-card border border-dashed transition-colors",
          dragging ? "border-brand bg-brand/8" : "border-line-strong bg-surface/50",
        )}
        data-testid="dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void handleDrop(event.dataTransfer);
        }}
      >
        {selected.length === 0 ? (
          <Empty icon={<Upload />} title="ここにアーカイブをドラッグ&ドロップ">
            または「ファイルを選ぶ」から辿ってください。zip / cbz / rar / 7z
            を扱えます。
          </Empty>
        ) : (
          <ul className="max-h-64 divide-y divide-line/60 overflow-y-auto p-1" data-testid="selected-list">
            {selected.map((path) => (
              <li
                key={path}
                data-testid="selected-item"
                data-path={path}
                className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-2"
              >
                <Package className="size-3.5 shrink-0 text-ink-faint" />
                <span className="shrink-0 text-[12.5px] font-medium">
                  {path.split("/").pop()}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-right text-[11px] text-ink-faint"
                  title={path}
                >
                  {path.slice(0, path.lastIndexOf("/")) || "/"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  title="一覧から外す"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => onChange(selected.filter((item) => item !== path))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? (
        <Alert tone="danger" data-testid="picker-error">
          <TriangleAlert />
          <span>{error}</span>
        </Alert>
      ) : null}

      {browsing ? (
        <Card data-testid="file-browser">
          <CardHeader>
            <Button
              variant="ghost"
              size="sm"
              data-testid="browse-up"
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
              variant="secondary"
              size="sm"
              data-testid="add-all-here"
              onClick={() =>
                add(entries.filter((entry) => !entry.is_directory).map((e) => e.path))
              }
            >
              ここのアーカイブを全部追加
            </Button>
          </CardHeader>
          <ul className="max-h-72 overflow-y-auto p-1">
            {entries.map((entry) => (
              <li
                key={entry.path}
                data-testid="browse-entry"
                data-name={entry.name}
                className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2"
              >
                {entry.is_directory ? (
                  <Folder className="size-3.5 shrink-0 text-brand/80" />
                ) : (
                  <Package className="size-3.5 shrink-0 text-ink-faint" />
                )}
                <button
                  type="button"
                  className="browser-name flex-1 truncate text-left text-[12.5px] hover:text-brand"
                  onClick={() =>
                    entry.is_directory ? load(entry.path) : add([entry.path])
                  }
                >
                  {entry.name}
                </button>
                {entry.is_directory ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => addFolder(entry)}
                  >
                    中身を追加
                  </Button>
                ) : selected.includes(entry.path) ? (
                  <Badge tone="ok">追加済み</Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}
