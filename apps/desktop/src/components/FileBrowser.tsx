import { ChevronUp, Folder, Package } from "lucide-react";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardHeader } from "./ui/card";

export type BrowseEntry = { name: string; path: string; is_directory: boolean };

/** いま見ている場所と、その 1 つ上。根まで来たら parent は無い */
export type BrowseLocation = { path: string; parent: string | null };

type FileBrowserProps = {
  location: BrowseLocation;
  entries: BrowseEntry[];
  /** すでに処理対象に入っているパス。二度追加しても増えないことを示す */
  selected: string[];
  /** 単一選択。まとめて追加する操作は指すものが無いので出さない */
  single: boolean;
  disabled: boolean;
  /** 与えられた高さいっぱいまで伸ばす */
  fill: boolean;
  onOpen: (path: string) => void;
  onAdd: (paths: string[]) => void;
  onAddFolder: (folder: BrowseEntry) => void;
};

/**
 * サーバー側を辿って対象を選ぶ一覧。
 *
 * ブラウザはドロップされたファイルの実パスを取得できないので、
 * 落とす以外の経路としてサイドカーが返す実パスを辿れるようにする。
 */
export function FileBrowser({
  location,
  entries,
  selected,
  single,
  disabled,
  fill,
  onOpen,
  onAdd,
  onAddFolder,
}: FileBrowserProps) {
  return (
    <Card
      data-testid="file-browser"
      className={cn("flex flex-col overflow-hidden", fill && "min-h-0 flex-1")}
    >
      <CardHeader>
        <Button
          variant="ghost"
          data-testid="browse-up"
          disabled={!location.parent}
          onClick={() => location.parent && onOpen(location.parent)}
        >
          <ChevronUp />
          上へ
        </Button>
        <code className="max-w-[52ch] truncate rounded bg-canvas px-2 py-0.5 text-[11.5px] text-ink-muted">
          {location.path}
        </code>
        <div className="flex-1" />
        {/* 単一選択では、まとめて追加しても 1 件しか残らず操作が嘘になる */}
        {single ? null : (
          <Button
            variant="secondary"
            data-testid="add-all-here"
            disabled={disabled}
            onClick={() =>
              onAdd(
                entries
                  .filter((entry) => !entry.is_directory)
                  .map((entry) => entry.path),
              )
            }
          >
            ここのアーカイブを全部追加
          </Button>
        )}
      </CardHeader>
      <ul
        className={cn(
          "overflow-y-auto p-1",
          fill ? "min-h-0 flex-1" : "max-h-72",
        )}
      >
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
                entry.is_directory ? onOpen(entry.path) : onAdd([entry.path])
              }
            >
              {entry.name}
            </button>
            {entry.is_directory && !single ? (
              <Button
                variant="ghost"
                disabled={disabled}
                onClick={() => onAddFolder(entry)}
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
  );
}
