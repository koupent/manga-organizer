import { ChevronUp, Folder, Package } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CardHeader } from "./ui/card";
import { DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

export type BrowseEntry = { name: string; path: string; is_directory: boolean };

/** いま見ている場所と、その 1 つ上。根まで来たら parent は無い */
export type BrowseLocation = { path: string; parent: string | null };

type FileBrowserDialogProps = {
  location: BrowseLocation;
  entries: BrowseEntry[];
  /** すでに処理対象に入っているパス。二度追加しても増えないことを示す */
  selected: string[];
  /** 単一選択。まとめて追加する操作は指すものが無いので出さない */
  single: boolean;
  disabled: boolean;
  /** 窓の見出し。何のために選ぶのかは呼び出し側の機能でしか分からない */
  title: string;
  /** 窓の説明。選んだ後に窓が閉じるかどうかは画面ごとに違う */
  description: string;
  onOpen: (path: string) => void;
  onAdd: (paths: string[]) => void;
};

/**
 * サーバー側を辿って対象を選ぶ一覧を、重ねた窓で出す。
 *
 * ブラウザはドロップされたファイルの実パスを取得できないので、
 * 落とす以外の経路としてサイドカーが返す実パスを辿れるようにする。
 *
 * 窓にしているのは、辿る一覧と処理対象の一覧が同じ作業面を奪い合っていたため。
 * 同じ面に置くと、両方を積めばどちらも半分の高さになり、片方だけを置けば
 * 何階層も辿って何件も入れる作業を、入れた一覧を見ないまま進めることになる。
 * 重ねれば奪い合いは起きず、入れたものを見ながら選べる。出力先の「参照」
 * （`DirectoryPicker`）が先に同じ形を採っているので、それに揃える。
 *
 * `Dialog` の根と開閉のボタンは `FilePicker` が持つ。ボタンを窓の外に置いたまま
 * 「この窓を開いた当人」として Radix に扱わせるには、同じ根の下に居る必要がある。
 */
export function FileBrowserDialog({
  location,
  entries,
  selected,
  single,
  disabled,
  title,
  description,
  onOpen,
  onAdd,
}: FileBrowserDialogProps) {
  return (
    <DialogContent
      data-testid="file-browser"
      // ファイル整理では、左の列（投入したもの）を塞がず右の作業面の上に
      // 重ねる。入れたものが左に増えていくのを見ながら次を選べ、開閉の
      // ボタン（左の列の見出し行）もそのまま押せる。右の作業面の中心は
      // 左の列 360px + 余白 12px×2 の半分だけ窓の中心より右にある
      className={
        single
          ? undefined
          : "left-[calc(50%+186px)] w-[min(52rem,calc(100vw-412px))]"
      }
    >
      {/* 見出しは窓の中では読み上げにだけ出す。いま見ている場所を出す
          code が実質の見出しで、文字の見出しを重ねると二段になる */}
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <DialogDescription className="sr-only">{description}</DialogDescription>
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
      {/* 窓そのものも 85vh で止まるが、溢れたぶんは行の側でスクロールさせる。
          窓ごと流れると「上へ」と現在地が画面の外へ出ていってしまう */}
      <ul className="max-h-[60vh] overflow-y-auto p-1">
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
            {/* フォルダは丸ごと 1 回で入れる。中を 1 階層だけ足していた頃は、
                サブフォルダの中まで届かず手で辿るしかなかった。何を入れたかは
                サイドカーが投入時に展開して確かめる */}
            {entry.is_directory && !single ? (
              <Button
                variant="ghost"
                disabled={disabled}
                onClick={() => onAdd([entry.path])}
              >
                フォルダごと追加
              </Button>
            ) : selected.includes(entry.path) ? (
              <Badge tone="ok">追加済み</Badge>
            ) : null}
          </li>
        ))}
      </ul>
    </DialogContent>
  );
}
