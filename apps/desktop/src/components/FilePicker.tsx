import {
  ChevronUp,
  Folder,
  FolderOpen,
  GripVertical,
  Package,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { parentDirectory } from "../path";
import { resolveDroppedPaths } from "../lib/dropped";
import { cn } from "../lib/utils";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardHeader } from "./ui/card";
import { Empty } from "./ui/empty";
import type { SidecarClient } from "../api/client";

type Entry = { name: string; path: string; is_directory: boolean };

/** 掴んだ行を送るキーと向き */
const MOVE_KEYS: Record<string, number> = { ArrowUp: -1, ArrowDown: 1 };

/** 掴む・置くに使うキー */
const GRAB_KEYS = ["Space", "Enter"];

/** from の要素を to の位置へ移した新しい配列を返す */
function moveWithin<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

type FilePickerProps = {
  client: SidecarClient;
  selected: string[];
  onChange: (paths: string[]) => void;
  disabled?: boolean;
  /** 単一選択。ページ並べ替えは 1 冊ずつしか扱えない */
  single?: boolean;
};

type SelectedItemProps = {
  path: string;
  position: number;
  sortable: boolean;
  disabled: boolean;
  grabbed: boolean;
  onGrab: (path: string | null) => void;
  onMove: (path: string, delta: number) => void;
  onRemove: (path: string) => void;
};

/** 一覧の 1 行。ドラッグとキーボードで順番を変え、Delete で一覧から外せる */
function SelectedItem({
  path,
  position,
  sortable,
  disabled,
  grabbed,
  onGrab,
  onMove,
  onRemove,
}: SelectedItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: path, disabled });
  const directory = parentDirectory(path);
  const gripRef = useRef<HTMLButtonElement>(null);

  // 並べ替えで行ごと DOM が動くと焦点が外れる。掴んだまま続けて送れるようにする
  useEffect(() => {
    if (grabbed) gripRef.current?.focus();
  }, [grabbed, position]);

  /** Space で掴み、矢印で送り、もう一度 Space で置く */
  const handleGripKey = (event: KeyboardEvent) => {
    if (disabled) return;
    if (GRAB_KEYS.includes(event.code)) {
      event.preventDefault();
      onGrab(grabbed ? null : path);
      return;
    }
    if (!grabbed) return;
    if (event.code === "Escape") {
      event.preventDefault();
      onGrab(null);
      return;
    }
    const delta = MOVE_KEYS[event.code];
    if (!delta) return;
    event.preventDefault();
    onMove(path, delta);
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="selected-item"
      data-path={path}
      data-position={position}
      tabIndex={0}
      className={cn(
        "group flex items-center gap-2 rounded px-2 py-1.5 outline-none",
        "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2",
        "focus-visible:ring-brand/40",
        isDragging && "opacity-40",
      )}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          onRemove(path);
        }
      }}
    >
      {/* 1 件しかなければ運ぶ先が無いので、掴む所も出さない */}
      {sortable ? (
        <button
          type="button"
          ref={gripRef}
          data-testid="selected-grip"
          className={cn(
            "cursor-grab touch-none text-ink-faint hover:text-ink-muted",
            grabbed && "text-brand",
          )}
          {...attributes}
          {...listeners}
          aria-label="ドラッグして順番を変える"
          aria-pressed={grabbed}
          onKeyDown={handleGripKey}
        >
          <GripVertical className="size-3.5" />
        </button>
      ) : (
        <GripVertical className="size-3.5 text-ink-faint/40" />
      )}
      <span className="tabular w-6 shrink-0 text-right text-[11px] text-ink-faint">
        {position + 1}
      </span>
      <Package className="size-3.5 shrink-0 text-ink-faint" />
      <span className="shrink-0 text-[12.5px] font-medium">
        {path.split("/").pop()}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-right text-[11px] text-ink-faint"
        title={path}
      >
        {directory}
      </span>
      <Button
        variant="ghost"
        size="icon"
        title="一覧から外す"
        aria-label="一覧から外す"
        data-testid="selected-remove"
        // Tab で辿り着いたときに見えないと押しどころが分からない
        className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        onClick={() => onRemove(path)}
      >
        <X />
      </Button>
    </li>
  );
}

/**
 * 処理対象の選択。
 *
 * 元の Tkinter 版と同じく、まとめて放り込んで一覧で確認する形にする。
 * ブラウザはドロップされたファイルの実パスを取得できないため、
 * サーバー側を辿って選ぶ経路も用意する。Tauri ではネイティブのドロップが
 * 実パスを届けるので、そちらも同じ一覧へ入る。
 *
 * single のときは 1 件だけを選ぶ（ページ並べ替え）。投入の経路が画面ごとに
 * 分かれると、実パスの引き当てのような壊れやすい所を二重に抱えるため、
 * 一覧を持つかどうかだけを変えて同じ入り口を使う。
 */
export function FilePicker({
  client,
  selected,
  onChange,
  disabled = false,
  single = false,
}: FilePickerProps) {
  const [browsing, setBrowsing] = useState(false);
  const [location, setLocation] = useState<{
    path: string;
    parent: string | null;
  }>({
    path: "",
    parent: null,
  });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  // キーボードで掴んでいる行。ドラッグと違い、置くまで状態を持ち続ける
  const [grabbed, setGrabbed] = useState<string | null>(null);

  // 通信の結果は実行が始まった後に届くことがある。そのときの状態で判断する
  const locked = useRef(disabled);
  locked.current = disabled;

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

  // ポインタ操作だけ dnd-kit に任せる。キーボードは下の onMove で自分で扱う。
  // dnd-kit の KeyboardSensor は掴んだ直後のキーを取りこぼすことがあるため。
  const sensors = useSensors(
    // 少し動かしただけで並べ替えが始まらないようにする
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  /**
   * 一覧を書き換える唯一の入り口。
   *
   * 実行中に中身が変わると、実際に処理される内容と画面が食い違う。
   * 経路ごとに止め忘れないよう、ここで一括して弾く。
   */
  const replace = (paths: string[]) => {
    if (locked.current) return;
    // 単一選択でまとめて投入されたら、黙って捨てずに先頭を採る。
    // どれを使ったかは呼び出し側が対象として画面に出す
    onChange(single ? paths.slice(0, 1) : paths);
  };

  const add = (paths: string[]) => {
    replace([...new Set([...selected, ...paths])]);
  };

  const remove = (path: string) => {
    replace(selected.filter((item) => item !== path));
  };

  /** ドラッグで入れ替えた順番をそのまま処理順にする */
  const reorder = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = selected.indexOf(String(active.id));
    const to = selected.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    replace(moveWithin(selected, from, to));
  };

  /** 掴んだ行を 1 つ隣へ送る。端に来たらそれ以上は動かさない */
  const moveByKey = (path: string, delta: number) => {
    const from = selected.indexOf(path);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= selected.length) return;
    replace(moveWithin(selected, from, to));
  };

  /** ドロップを受ける。実パスの引き当ては単一選択と共通の経路で行う */
  const handleDrop = async (transfer: DataTransfer) => {
    if (locked.current) return;
    const { paths, error: reason } = await resolveDroppedPaths(
      client,
      transfer,
    );
    if (paths.length > 0) add(paths);
    setError(reason);
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

  // 2 件以上でなければ運ぶ先が無い。並べ替えの仕掛けごと出さない
  const sortable = selected.length > 1;

  const list = (
    <ul
      className="max-h-64 divide-y divide-line/60 overflow-y-auto p-1"
      data-testid="selected-list"
    >
      {selected.map((path, index) => (
        <SelectedItem
          key={path}
          path={path}
          position={index}
          sortable={sortable}
          disabled={disabled}
          grabbed={grabbed === path}
          onGrab={setGrabbed}
          onMove={moveByKey}
          onRemove={remove}
        />
      ))}
    </ul>
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-semibold">
          {single ? "並べ替えるアーカイブ" : "処理対象ファイル"}
        </h2>
        {/* 単一選択は一覧を持たない。件数も一括操作も指すものが無い */}
        {single ? null : (
          <>
            <span
              className="tabular text-[12px] text-ink-faint"
              data-testid="selected-count"
            >
              {selected.length} 件
            </span>
            {selected.length > 0 ? (
              <span className="text-[11.5px] text-ink-faint">
                {sortable
                  ? "ドラッグで順番変更 / Delete で削除"
                  : "Delete で削除"}
              </span>
            ) : null}
          </>
        )}
        <div className="flex-1" />
        <Button
          variant={browsing ? "primary" : "secondary"}
          size="sm"
          data-testid="open-browser"
          disabled={disabled}
          onClick={() => setBrowsing((open) => !open)}
        >
          <FolderOpen />
          {browsing ? "選択を閉じる" : "ファイルを選ぶ"}
        </Button>
        {single ? null : (
          <Button
            variant="ghost"
            size="sm"
            data-testid="clear-selection"
            disabled={disabled || selected.length === 0}
            onClick={() => replace([])}
          >
            一覧を空にする
          </Button>
        )}
      </div>

      <div
        className={cn(
          "rounded-card border border-dashed transition-colors",
          dragging
            ? "border-brand bg-brand/8"
            : "border-line-strong bg-surface/50",
        )}
        data-testid="dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          // 受け取れないときに受け取れそうな見た目にしない
          setDragging(!disabled);
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
            {single
              ? "まとめて落としたときは先頭の 1 件を対象にします。"
              : null}
          </Empty>
        ) : sortable ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={reorder}
          >
            <SortableContext
              items={selected}
              strategy={verticalListSortingStrategy}
              disabled={disabled}
            >
              {list}
            </SortableContext>
          </DndContext>
        ) : (
          list
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
            {/* 単一選択では、まとめて追加しても 1 件しか残らず操作が嘘になる */}
            {single ? null : (
              <Button
                variant="secondary"
                size="sm"
                data-testid="add-all-here"
                disabled={disabled}
                onClick={() =>
                  add(
                    entries
                      .filter((entry) => !entry.is_directory)
                      .map((e) => e.path),
                  )
                }
              >
                ここのアーカイブを全部追加
              </Button>
            )}
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
                {entry.is_directory && !single ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
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
