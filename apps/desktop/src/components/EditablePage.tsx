import { GripVertical, MoreHorizontal, ZoomIn } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export function EditablePage({
  id,
  name,
  span,
  cover,
  disabled,
  selected,
  onSelect,
  onZoom,
  canCover,
  onCover,
  onAdjust,
  deleted,
  displayName = name,
  canDelete,
  deleteLabel,
  onDelete,
  children,
}: {
  id: string;
  name: string;
  span: boolean;
  cover: boolean;
  disabled: boolean;
  selected: boolean;
  onSelect: (event: MouseEvent) => void;
  onZoom: () => void;
  canCover: boolean;
  onCover: () => void;
  onAdjust: () => void;
  deleted: boolean;
  displayName?: string;
  canDelete: boolean;
  deleteLabel: string;
  onDelete: () => void;
  children: ReactNode;
}) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: disabled || deleted });
  const [menu, setMenu] = useState(false);
  const tools = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!tools.current?.contains(event.target as Node)) setMenu(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);
  return (
    <div
      ref={setNodeRef}
      data-testid="editable-page"
      data-name={name}
      data-cover={cover}
      data-selected={selected}
      data-deleted={deleted}
      className={cn(
        "relative min-w-0 rounded border",
        cover ? "border-brand ring-1 ring-brand" : "border-transparent",
        selected && "ring-2 ring-brand/50",
        isDragging && "z-20 opacity-70",
      )}
      style={{
        gridColumn: span ? "span 2" : undefined,
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <div
        ref={tools}
        className="relative flex h-7 items-center gap-1 px-1"
        dir="ltr"
      >
        <Button
          variant="ghost"
          size="icon"
          className="size-6 cursor-grab touch-none"
          title="ドラッグしてページを並べ替える"
          aria-label={`${displayName} を並べ替える`}
          data-testid="page-drag-handle"
          disabled={disabled || deleted}
          {...attributes}
          {...listeners}
        >
          <GripVertical />
        </Button>
        <Button
          variant="ghost"
          className="h-6 min-w-0 flex-1 justify-start truncate px-0 text-[11px]"
          title={`${displayName} を選択`}
          aria-label={`${displayName} を選択`}
          disabled={disabled || deleted}
          onClick={onSelect}
        >
          {cover ? "サムネイル" : displayName}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          data-testid="zoom"
          title="原寸で表示"
          aria-label={`${displayName} を原寸で表示`}
          disabled={disabled}
          onClick={onZoom}
        >
          <ZoomIn />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`${displayName} の操作`}
          aria-expanded={menu}
          disabled={disabled}
          onClick={() => setMenu(!menu)}
        >
          <MoreHorizontal />
        </Button>
        {menu ? (
          <div
            role="menu"
            className="absolute top-7 right-0 z-30 flex w-48 flex-col rounded border border-line bg-surface p-1 shadow-lg"
          >
            <Button
              variant="ghost"
              role="menuitem"
              disabled={!canCover}
              className="justify-start"
              onClick={() => {
                onCover();
                setMenu(false);
              }}
            >
              サムネイルにする
            </Button>
            <Button
              variant="ghost"
              role="menuitem"
              disabled={!canCover}
              className="justify-start"
              onClick={() => {
                onAdjust();
                setMenu(false);
              }}
            >
              サムネイルの画像調整
            </Button>
            {!canCover && !deleted ? (
              <span className="p-2 text-[11px] text-ink-muted">
                このページの分割・結合を先に保存してください
              </span>
            ) : null}
            <Button
              variant="ghost"
              role="menuitem"
              disabled={!canDelete}
              className="justify-start"
              onClick={() => {
                onDelete();
                setMenu(false);
              }}
            >
              {deleted ? "ページを復元" : deleteLabel}
            </Button>
          </div>
        ) : null}
      </div>
      <div
        dir="ltr"
        role="group"
        aria-label={displayName}
        onClick={(event) => {
          if (
            !disabled &&
            !deleted &&
            !(event.target as HTMLElement).closest(
              "button,input,[role=checkbox]",
            )
          )
            onSelect(event);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (!disabled) setMenu(true);
        }}
      >
        {children}
      </div>
    </div>
  );
}
