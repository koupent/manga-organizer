import { FolderOpen, Save, Undo2, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SidecarClient } from "../api/client";
import { useStoredNumber } from "../lib/setting";

const MAX_HISTORY = 100;

/**
 * 表示サイズ（サムネイル 1 枚の最小幅・px）の可動域と既定。
 *
 * 既定を可動域と同じ所で決める。離して置くと、可動域を動かしたときに
 * 既定が外へ出ても誰も気づけない。
 *
 * 既定は 160px。単行本は 150〜200 ページあり、1 行 5 枚（220px）では
 * 全体を見渡すのに何度も転がすことになる。ページ順の異常を探すという
 * 用途に合わせて密を既定にした。1280px の窓で 1 行 7 枚になり、
 * 判別できる大きさを保ったまま、詰める側にも広げる側にも余地が残る。
 */
const CARD_WIDTH_MIN = 140;
const CARD_WIDTH_MAX = 520;
const CARD_WIDTH_STEP = 20;
const CARD_WIDTH_DEFAULT = 160;

/** 表示サイズの保存先。画面を移っても開き直しても同じ見え方に戻す */
const CARD_WIDTH_KEY = "reorder.cardWidth";

type PageCardProps = {
  name: string;
  position: number;
  moved: boolean;
  selected: boolean;
  thumbnailUrl: string;
  onSelect: (name: string, event: React.MouseEvent) => void;
  onZoom: (name: string) => void;
};

/** 1 ページ分のカード。ドラッグで並べ替え、クリックで選択する */
function PageCard({
  name,
  position,
  moved,
  selected,
  thumbnailUrl,
  onSelect,
  onZoom,
}: PageCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: name });
  const label = name.split("/").pop() ?? name;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "group overflow-hidden rounded-card border bg-surface transition-all",
        "cursor-grab touch-none select-none hover:-translate-y-0.5",
        isDragging && "opacity-30 cursor-grabbing",
        selected
          ? "border-brand ring-2 ring-brand/25"
          : "border-line hover:border-line-strong",
      )}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="page-card"
      data-name={name}
      data-position={position}
      data-selected={selected}
      onClick={(event) => onSelect(name, event)}
      {...attributes}
      {...listeners}
    >
      <img
        className="block aspect-2/3 w-full bg-canvas object-contain pointer-events-none"
        src={thumbnailUrl}
        alt={label}
        loading="lazy"
      />
      <div className="flex items-center gap-1.5 border-t border-line px-2 py-1.5">
        <span
          className={cn(
            "tabular min-w-6 rounded px-1.5 py-0.5 text-center text-[11px] font-semibold",
            moved ? "bg-brand text-brand-ink" : "bg-surface-2 text-ink-muted",
          )}
        >
          {position}
        </span>
        <span className="flex-1 truncate text-[11px] text-ink-faint">
          {label}
        </span>
        <button
          type="button"
          data-testid="zoom"
          title="原寸で表示"
          className="rounded p-0.5 text-ink-faint opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink group-hover:opacity-100"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onZoom(name);
          }}
        >
          <ZoomIn className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

type PageGridProps = {
  client: SidecarClient;
  archive: string;
  archiveName?: string;
  pages: { name: string; size: number; modified: string }[];
  /** いま見えている画面かどうか。隠れている間は入力を受けない */
  active?: boolean;
  onSaved?: (message: string) => void;
  /** 別のアーカイブを選び直す。渡さなければ選び直す導線を出さない */
  onChangeArchive?: () => void;
};

/** サムネイルを並べ、ドラッグで順番を入れ替えて保存する */
export function PageGrid({
  client,
  archive,
  archiveName,
  pages,
  active = true,
  onSaved,
  onChangeArchive,
}: PageGridProps) {
  const original = useMemo(() => pages.map((page) => page.name), [pages]);
  // 表示サイズはこの画面だけの設定なので、この画面が持つ。
  // 対象を選び直すとこの部品ごと作り直されるが、保存された値から始まるので
  // 置き場所に関わらず利用者が決めた見え方に戻る
  const [cardWidth, setCardWidth] = useStoredNumber(
    CARD_WIDTH_KEY,
    CARD_WIDTH_DEFAULT,
  );
  const [order, setOrder] = useState<string[]>(original);
  const [selection, setSelection] = useState<string[]>([]);
  const [history, setHistory] = useState<string[][]>([]);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const lastClicked = useRef<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const dirty = order.some((name, index) => name !== original[index]);

  const commit = useCallback(
    (next: string[]) => {
      setHistory((past) => [...past, order].slice(-MAX_HISTORY));
      setOrder(next);
    },
    [order],
  );

  /** 選択をまとめて targetIndex の位置へ移す */
  const moveNames = useCallback(
    (names: string[], targetIndex: number) => {
      const moving = new Set(names);
      const anchor = order[targetIndex] ?? null;
      // 選択の内側へ落とした位置は、取り除いた後には存在しない。動かさない
      if (anchor !== null && moving.has(anchor)) return;
      const remaining = order.filter((name) => !moving.has(name));
      const ordered = order.filter((name) => moving.has(name));
      const at = anchor === null ? remaining.length : remaining.indexOf(anchor);
      const position = at < 0 ? remaining.length : at;
      commit([
        ...remaining.slice(0, position),
        ...ordered,
        ...remaining.slice(position),
      ]);
    },
    [commit, order],
  );

  const select = (name: string, event: React.MouseEvent) => {
    if (event.shiftKey && lastClicked.current) {
      const from = order.indexOf(lastClicked.current);
      const to = order.indexOf(name);
      const [start, end] = from < to ? [from, to] : [to, from];
      setSelection(order.slice(start, end + 1));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      setSelection((current) =>
        current.includes(name)
          ? current.filter((item) => item !== name)
          : [...current, name],
      );
      lastClicked.current = name;
      return;
    }
    setSelection([name]);
    lastClicked.current = name;
  };

  const handleDragStart = (event: DragStartEvent) => {
    const name = String(event.active.id);
    // 選択外を掴んだらその 1 枚だけを動かす
    if (!selection.includes(name)) {
      setSelection([name]);
      lastClicked.current = name;
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const dragged = selection.includes(String(active.id))
      ? order.filter((name) => selection.includes(name))
      : [String(active.id)];
    const overIndex = order.indexOf(String(over.id));
    const activeIndex = order.indexOf(String(active.id));
    // 後ろへ動かすときは対象の次の位置へ差し込む
    moveNames(dragged, activeIndex < overIndex ? overIndex + 1 : overIndex);
  };

  const undo = useCallback(() => {
    setHistory((past) => {
      if (past.length === 0) return past;
      setOrder(past[past.length - 1]);
      return past.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    // 隠れている間は窓ごとの押鍵を拾わない。別の画面で Ctrl+Z を押したとき、
    // 見えていない格子の並べ替えが黙って巻き戻るのを防ぐ
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setZoomed(null);
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key === "z") {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, active]);

  const save = async () => {
    setSaving(true);
    setStatus("保存しています...");
    try {
      const accepted = await client.reorder(archive, order);
      const job = await client.waitForJob(accepted.id);
      if (job.state !== "succeeded") {
        throw new Error(job.error ?? "保存に失敗しました");
      }
      const count =
        typeof job.result === "object" && job.result !== null
          ? ((job.result as { pageCount?: number }).pageCount ?? order.length)
          : order.length;
      const message = `${count} ページを並び替えました`;
      setStatus(message);
      setHistory([]);
      onSaved?.(message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2
          className="text-[13px] font-semibold"
          data-testid="reorder-archive-name"
        >
          {archiveName ?? "ページ修正"}
        </h2>
        {onChangeArchive ? (
          <Button
            variant="ghost"
            data-testid="change-archive"
            onClick={onChangeArchive}
          >
            <FolderOpen />
            別のファイルを選ぶ
          </Button>
        ) : null}
        <span className="tabular text-[12px] text-ink-faint">
          {pages.length} ページ
        </span>
        <Badge tone={dirty ? "warn" : "neutral"} data-testid="dirty-state">
          {dirty ? "未保存の変更があります" : "変更はありません"}
        </Badge>
        <span
          className="tabular text-[12px] text-ink-faint"
          data-testid="selection-count"
        >
          {selection.length} 件選択
        </span>
        {/* 画面固有の操作なので、共通ヘッダーではなく対象ファイル名や保存と
            同じ並びに置く。伸び縮みする status より左に置き、文字が増えても
            つまみの位置が動かないようにする */}
        <label className="flex items-center gap-2 text-[12px] text-ink-muted">
          表示サイズ
          <input
            type="range"
            min={CARD_WIDTH_MIN}
            max={CARD_WIDTH_MAX}
            step={CARD_WIDTH_STEP}
            value={cardWidth}
            data-testid="card-width"
            onChange={(event) => setCardWidth(Number(event.target.value))}
            className="h-1 w-28 cursor-pointer accent-brand"
          />
        </label>
        <div className="flex-1" />
        <span className="text-[12px] text-ink-muted" data-testid="status">
          {status}
        </span>
        <Button
          variant="secondary"
          data-testid="undo"
          disabled={history.length === 0}
          onClick={undo}
        >
          <Undo2 />
          元に戻す
        </Button>
        <Button
          variant="primary"
          size="lg"
          data-testid="save"
          disabled={!dirty || saving}
          onClick={save}
        >
          <Save />
          ZIP に保存
        </Button>
      </div>

      <p className="text-[11.5px] text-ink-faint">
        ドラッグで順番を入れ替え ・ <Key>Ctrl</Key>/<Key>Shift</Key>
        +クリックで複数選択 ・ <Key>Ctrl</Key>+<Key>Z</Key> で元に戻す ・
        虫眼鏡で原寸表示
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={order} strategy={rectSortingStrategy}>
          <div
            className="grid gap-3"
            style={{
              gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))`,
            }}
          >
            {order.map((name, index) => (
              <PageCard
                key={name}
                name={name}
                position={index + 1}
                moved={original[index] !== name}
                selected={selection.includes(name)}
                thumbnailUrl={client.thumbnailUrl(archive, name, cardWidth)}
                onSelect={select}
                onZoom={setZoomed}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {zoomed ? (
        <div
          className="fixed inset-0 z-40 flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-black/94 p-6"
          data-testid="lightbox"
          onClick={() => setZoomed(null)}
        >
          <img
            data-testid="lightbox-image"
            className="max-h-[82vh] max-w-[92vw] rounded shadow-2xl"
            src={client.imageUrl(archive, zoomed)}
            alt={zoomed}
          />
          <span className="text-[12px] text-ink-faint">
            {zoomed}（クリックまたは Esc で閉じる）
          </span>
        </div>
      ) : null}
    </section>
  );
}

/** ヒント内のキー表記 */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface-2 px-1 py-px text-[10.5px] font-sans">
      {children}
    </kbd>
  );
}
