import {
  ChevronRight,
  ChevronUp,
  CircleCheck,
  Folder,
  FolderOpen,
  FolderPlus,
  Package,
  Plus,
  X,
} from "lucide-react";
import { isInside } from "../lib/plan";
import { cn } from "../lib/utils";
import { SHORTCUT_SIZE } from "./EditShortcuts";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CardHeader } from "./ui/card";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";

export type BrowseEntry = { name: string; path: string; is_directory: boolean };

/** いま見ている場所と、その 1 つ上。根まで来たら parent は無い */
export type BrowseLocation = { path: string; parent: string | null };

type FileBrowserDialogProps = {
  location: BrowseLocation;
  /** 辿れる一番上（許された場所の根）。パンくずはここから始める */
  root: string;
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

/** 根からいまの場所までの段。各段を押すとそこへ飛べる */
function crumbsOf(path: string, root: string) {
  if (!root || (path !== root && !isInside(root, path))) {
    return [{ label: path, path }];
  }
  const separator = path.includes("\\") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  const parts = path.slice(root.length).split(/[\\/]/).filter(Boolean);
  return [
    { label: root, path: root },
    ...parts.map((part, index) => ({
      label: part,
      path: [base, ...parts.slice(0, index + 1)].join(separator),
    })),
  ];
}

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
 * 「ここのアーカイブを全部追加」は置かない。直下のアーカイブだけを足すので、
 * フォルダしか無い場所では黙って 0 件になっていた。代わりに「ここをフォルダ
 * ごと追加」で、この場所そのものを入れる（下の階層まで辿られる）。
 *
 * `Dialog` の根と開閉のボタンは `FilePicker` が持つ。ボタンを窓の外に置いたまま
 * 「この窓を開いた当人」として Radix に扱わせるには、同じ根の下に居る必要がある。
 */
export function FileBrowserDialog({
  location,
  root,
  entries,
  selected,
  single,
  disabled,
  title,
  description,
  onOpen,
  onAdd,
}: FileBrowserDialogProps) {
  const addedHere = selected.includes(location.path);
  // 上のフォルダごと入っている場所では、中の物を足しても同じ本が二重に出る（#109）
  const insideAdded = selected.some((path) => isInside(path, location.path));
  const covered = addedHere || insideAdded;

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
      <div className="flex h-7 shrink-0 items-center gap-2.5">
        <DialogTitle className="text-[13.5px] font-semibold">
          {title}
        </DialogTitle>
        <DialogDescription
          className={
            single ? "sr-only" : "truncate text-[11.5px] text-ink-faint"
          }
        >
          {description}
        </DialogDescription>
        <div className="flex-1" />
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="閉じる"
            title="閉じる"
          >
            <X />
          </Button>
        </DialogClose>
      </div>

      <CardHeader className="min-h-10 flex-nowrap">
        <Button
          variant="ghost"
          data-testid="browse-up"
          disabled={!location.parent}
          onClick={() => location.parent && onOpen(location.parent)}
        >
          <ChevronUp />
          上へ
        </Button>
        {/* 各段を押せば何段でも飛べる。「上へ」を何度も押させない */}
        <nav
          aria-label="いまの場所"
          className="flex min-w-0 items-center gap-0.5 overflow-hidden rounded-control bg-surface px-1.5 py-0.5 font-mono text-[12px] text-ink-muted"
        >
          {crumbsOf(location.path, root).map((crumb, index, all) => (
            <span
              key={crumb.path}
              className="flex min-w-0 items-center gap-0.5"
            >
              {index > 0 ? (
                <ChevronRight className="size-3 shrink-0 text-ink-faint" />
              ) : null}
              <button
                type="button"
                data-testid="browse-crumb"
                data-path={crumb.path}
                className={cn(
                  "truncate rounded px-0.5 hover:text-brand",
                  index === all.length - 1 && "font-semibold text-ink",
                )}
                title={crumb.path}
                onClick={() => onOpen(crumb.path)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex-1" />
        {/* 単一選択では、場所ごと入れる操作は指すものが無い */}
        {single ? null : covered ? (
          <Badge
            tone={addedHere ? "ok" : "neutral"}
            data-testid="browse-here-state"
          >
            {addedHere ? "この場所は追加済み" : "上のフォルダごと追加済み"}
          </Badge>
        ) : (
          <Button
            data-testid="add-here"
            // 根（ホーム）を丸ごと入れると、下の階層を全部辿ることになる（#110）
            disabled={disabled || location.path === root}
            title={
              location.path === root
                ? "一番上の場所は丸ごと入れられません。中のフォルダを選んでください"
                : undefined
            }
            onClick={() => onAdd([location.path])}
          >
            <FolderPlus />
            ここをフォルダごと追加
          </Button>
        )}
      </CardHeader>

      {/* 窓そのものも 85vh で止まるが、溢れたぶんは行の側でスクロールさせる。
          窓ごと流れると「上へ」と現在地が画面の外へ出ていってしまう */}
      <ul className="flex h-[400px] max-h-[50vh] flex-col overflow-y-auto rounded-card border border-line bg-surface/50 p-1">
        {entries.length === 0 ? (
          <li
            data-testid="browse-empty"
            className="m-auto p-3 text-[12px] text-ink-faint"
          >
            この中にフォルダもアーカイブもありません
          </li>
        ) : null}
        {entries.map((entry) => {
          const added = selected.includes(entry.path);
          // 入れた物の中や、入れた物そのものを足しても増えない
          const blocked = !single && (covered || added);
          return (
            <li
              key={entry.path}
              data-testid="browse-entry"
              data-name={entry.name}
              className="flex h-7 shrink-0 items-center gap-2 rounded-control px-2 hover:bg-surface-2"
            >
              {entry.is_directory ? (
                <Folder className="size-3.5 shrink-0 text-brand/80" />
              ) : (
                <Package className="size-3.5 shrink-0 text-ink-faint" />
              )}
              <button
                type="button"
                className={cn(
                  "browser-name flex-1 truncate text-left text-[12.5px] hover:text-brand",
                  entry.is_directory && "text-brand",
                )}
                onClick={() => {
                  if (entry.is_directory) onOpen(entry.path);
                  else if (!blocked) onAdd([entry.path]);
                }}
              >
                {entry.name}
              </button>
              <EntryAction
                entry={entry}
                single={single}
                added={added}
                covered={covered}
                disabled={disabled}
                onAdd={onAdd}
              />
            </li>
          );
        })}
      </ul>

      <div
        className="flex h-7 shrink-0 items-center gap-2"
        data-testid="browse-footer"
      >
        <span className="min-w-0 truncate text-[11.5px] text-ink-faint">
          {single
            ? "選ぶとすぐに開きます"
            : `投入したもの: ${selected.length} 件 · 追加しても閉じません。入れ終えたら閉じてください`}
        </span>
        <div className="flex-1" />
        <DialogClose asChild>
          <Button data-testid="browse-close">閉じる</Button>
        </DialogClose>
      </div>
    </DialogContent>
  );
}

/**
 * 行の右端。何が出来るかを枠付きのボタンで示し、済んだものは印に替える。
 *
 * ghost のボタンは行の地に溶けて押せる物に見えない。押せる物は枠を付けて
 * 24px で揃え、押せない物（済んだもの）は印にする。
 */
function EntryAction({
  entry,
  single,
  added,
  covered,
  disabled,
  onAdd,
}: {
  entry: BrowseEntry;
  single: boolean;
  added: boolean;
  covered: boolean;
  disabled: boolean;
  onAdd: (paths: string[]) => void;
}) {
  if (single) {
    // 1 冊だけ選ぶ画面は、アーカイブを開くだけ。フォルダは辿るもの
    if (entry.is_directory) return null;
    return (
      <Button
        className={SHORTCUT_SIZE}
        disabled={disabled}
        onClick={() => onAdd([entry.path])}
      >
        <FolderOpen />
        開く
      </Button>
    );
  }
  if (added) {
    return (
      <Badge tone="ok" data-testid="browse-added">
        <CircleCheck className="size-3" />
        追加済み
      </Badge>
    );
  }
  if (covered) return <Badge tone="neutral">上のフォルダごと追加済み</Badge>;
  return (
    <Button
      className={SHORTCUT_SIZE}
      disabled={disabled}
      onClick={() => onAdd([entry.path])}
    >
      {entry.is_directory ? <FolderPlus /> : <Plus />}
      {entry.is_directory ? "フォルダごと追加" : "追加"}
    </Button>
  );
}
