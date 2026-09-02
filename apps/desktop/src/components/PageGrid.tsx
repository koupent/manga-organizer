import { useMemo, useState } from "react";
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
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SidecarClient } from "../api/client";

type PageCardProps = {
  name: string;
  label: string;
  position: number;
  moved: boolean;
  thumbnailUrl: string;
};

/** 1 ページ分のカード。ドラッグで並べ替える */
function PageCard({ name, label, position, moved, thumbnailUrl }: PageCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: name });

  return (
    <div
      ref={setNodeRef}
      className={`card${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="page-card"
      data-name={name}
      data-position={position}
      {...attributes}
      {...listeners}
    >
      <img className="thumb" src={thumbnailUrl} alt={label} loading="lazy" />
      <div className="meta">
        <span className={`position${moved ? " moved" : ""}`}>{position}</span>
        <span className="label">{label}</span>
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
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  // わずかな移動でドラッグ扱いにすると、クリックが取りこぼされる
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const dirty = order.some((name, index) => name !== original[index]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrder((current) => {
      const from = current.indexOf(String(active.id));
      const to = current.indexOf(String(over.id));
      return arrayMove(current, from, to);
    });
  };

  const save = async () => {
    setSaving(true);
    setStatus("保存しています...");
    try {
      const accepted = await client.reorder(archive, order);
      const job = await client.waitForJob(accepted.id);
      if (job.state !== "succeeded") {
        throw new Error(job.error ?? "保存に失敗しました");
      }
      const message =
        typeof job.result === "object" && job.result !== null
          ? `${(job.result as { pageCount?: number }).pageCount ?? order.length} ページを並び替えました`
          : "保存しました";
      setStatus(message);
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
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={order} strategy={rectSortingStrategy}>
          <div className="grid" style={{ ["--card-width" as string]: `${cardWidth}px` }}>
            {order.map((name, index) => (
              <PageCard
                key={name}
                name={name}
                label={name.split("/").pop() ?? name}
                position={index + 1}
                moved={original[index] !== name}
                thumbnailUrl={client.thumbnailUrl(archive, name, cardWidth)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  );
}
