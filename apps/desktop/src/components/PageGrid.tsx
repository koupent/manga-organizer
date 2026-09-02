import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SidecarClient } from "../api/client";

const MAX_HISTORY = 100;

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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: name });
  const label = name.split("/").pop() ?? name;

  return (
    <div
      ref={setNodeRef}
      className={`card${isDragging ? " dragging" : ""}${selected ? " selected" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="page-card"
      data-name={name}
      data-position={position}
      data-selected={selected}
      onClick={(event) => onSelect(name, event)}
      {...attributes}
      {...listeners}
    >
      <img className="thumb" src={thumbnailUrl} alt={label} loading="lazy" />
      <div className="meta">
        <span className={`position${moved ? " moved" : ""}`}>{position}</span>
        <span className="label">{label}</span>
        <button
          type="button"
          className="zoom"
          data-testid="zoom"
          title="原寸で表示"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onZoom(name);
          }}
        >
          🔍
        </button>
      </div>
    </div>
  );
}

type PageGridProps = {
  client: SidecarClient;
  archive: string;
  pages: { name: string; size: number; modified: string }[];
  cardWidth: number;
  onSaved?: (message: string) => void;
};

/** サムネイルを並べ、ドラッグで順番を入れ替えて保存する */
export function PageGrid({
  client,
  archive,
  pages,
  cardWidth,
  onSaved,
}: PageGridProps) {
  const original = useMemo(() => pages.map((page) => page.name), [pages]);
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

  const commit = useCallback((next: string[]) => {
    setHistory((past) => [...past, order].slice(-MAX_HISTORY));
    setOrder(next);
  }, [order]);

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
  }, [undo]);

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
    <section>
      <div className="toolbar">
        <span data-testid="dirty-state">
          {dirty ? "未保存の変更があります" : "変更はありません"}
        </span>
        <span data-testid="selection-count">{selection.length} 件選択</span>
        <button
          type="button"
          data-testid="undo"
          disabled={history.length === 0}
          onClick={undo}
        >
          元に戻す
        </button>
        <button
          type="button"
          data-testid="save"
          disabled={!dirty || saving}
          onClick={save}
        >
          ZIP に保存
        </button>
        <span data-testid="status">{status}</span>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={order} strategy={rectSortingStrategy}>
          <div
            className="grid"
            style={{ ["--card-width" as string]: `${cardWidth}px` }}
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
          className="overlay"
          data-testid="lightbox"
          onClick={() => setZoomed(null)}
        >
          <img
            data-testid="lightbox-image"
            src={client.imageUrl(archive, zoomed)}
            alt={zoomed}
          />
          <span>{zoomed}（クリックまたは Esc で閉じる）</span>
        </div>
      ) : null}
    </section>
  );
}
