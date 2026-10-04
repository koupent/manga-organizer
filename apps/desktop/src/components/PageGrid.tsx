import { Save, Undo2, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { EditorLayout } from "./EditorLayout";
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
import { sidecarReason, type SidecarClient } from "../api/client";
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
      // 格子は右綴じの並び（右から左）にするが、カードの中身は左から右のまま
      dir="ltr"
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

type Page = { name: string; size: number; modified: string };

const namesOf = (pages: Page[]) => pages.map((page) => page.name);

type PageGridProps = {
  client: SidecarClient;
  archive: string;
  pages: Page[];
  /** いま見えている画面かどうか。隠れている間は入力を受けない */
  active?: boolean;
  onSaved?: (message: string) => void;
  /** アーカイブを書き換えたことを伝える。他の画面が持つページは古くなる */
  onArchiveChanged?: () => void;
};

/** サムネイルを並べ、ドラッグで順番を入れ替えて保存する */
export function PageGrid({
  client,
  archive,
  pages,
  active = true,
  onSaved,
  onArchiveChanged,
}: PageGridProps) {
  // 表示サイズはこの画面だけの設定なので、この画面が持つ。
  // 対象を選び直すとこの部品ごと作り直されるが、保存された値から始まるので
  // 置き場所に関わらず利用者が決めた見え方に戻る
  const [cardWidth, setCardWidth] = useStoredNumber(
    CARD_WIDTH_KEY,
    CARD_WIDTH_DEFAULT,
  );
  /**
   * 開いたときの並び。これと見比べて「未保存の変更」が決まる。
   *
   * プロップをそのまま使わないのは、書き込みの後は自分で読み直すため。
   * 書き込むと ZIP の連番は振り直され、同じ名前が別の絵を指す。プロップの
   * 更新を待っていると、その間に押した保存は消えた名前を並べて送ることになる。
   */
  const [original, setOriginal] = useState<string[]>(() => namesOf(pages));
  const [order, setOrder] = useState<string[]>(original);
  const [selection, setSelection] = useState<string[]>([]);
  const [history, setHistory] = useState<string[][]>([]);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  /**
   * 絵の URL に添える世代。
   *
   * 並べ替えると ZIP の連番は振り直され、**名前は据え置きのまま中身だけが
   * 入れ替わる**。URL が同じままだと、ブラウザは取り直しに行かない
   * （/api/thumb の no-cache は、要求が飛んで初めて効く）。番号だけが新しく
   * 絵が古い格子を渡された利用者は、直したはずの順序がまた崩れて見え、
   * 並べ直してもう一度保存する。
   */
  const [reloadKey, setReloadKey] = useState(0);
  const lastClicked = useRef<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  /**
   * 別のページ一覧を基準にして組み直す。
   *
   * 並べ替えの途中経過も履歴も選択も、前の一覧の名前でできている。新しい一覧に
   * 無い名前を持ち越すと、次の保存で存在しないページを並べて送ることになる。
   */
  const rebase = useCallback((names: string[]) => {
    setOriginal(names);
    setOrder(names);
    setHistory([]);
    setSelection([]);
    lastClicked.current = null;
    // 組み直す切っ掛けは、いつも「本が書き換わった」こと。同じ名前がもう別の
    // 絵を指しているので、絵も取り直させる
    setReloadKey((key) => key + 1);
  }, []);

  /**
   * 一覧が入れ替わったら組み直す。
   *
   * 部品を作り直させるだけでは足りない。別の画面が本を書き換えたとき、作り直しの
   * 切っ掛け（世代）と新しい一覧が同時に届く保証は無く、先に作り直された格子は
   * 古い一覧で組まれる。後から届く一覧をここで拾わないと、割って増えたページが
   * 一生出てこない画面のまま、消えた名前で保存を押させることになる。
   */
  const applied = useRef(pages);
  useEffect(() => {
    if (applied.current === pages) return;
    applied.current = pages;
    rebase(namesOf(pages));
  }, [pages, rebase]);

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
    // 本へ書き終えたかどうかを、失敗を捌く所まで持ち越す。断られた保存と、
    // 書き終えた後の読み直しの失敗とでは、その後に押させてよいかが逆になる
    let written = "";
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
      written = `${count} ページを並び替えました`;
      // 並べ替えると連番が振り直され、同じ名前が別の絵を指す。
      // この本を抱えている他の画面は、そのままでは古い中身を見せ続ける
      onArchiveChanged?.();
      // 振り直された連番は、この画面にも要る。読み直さないと基準が書き込む前の
      // ままで「未保存の変更があります」が消えず、画面が抱える名前も古い。
      // 利用者はもう一度保存を押し、覚えの無い並びを本へ書き込むことになる
      const listed = await client.listPages(archive);
      rebase(namesOf(listed.pages as Page[]));
      setStatus(written);
      onSaved?.(written);
      setSaving(false);
    } catch (error) {
      const reason = sidecarReason(error);
      if (written !== "") {
        // 書き込みは通っていて、失敗したのはその後の読み直しだけ。押せる状態へ
        // 戻さない。画面が抱えている名前は書き込む前のもので、その名前はもう
        // 別の絵を指している。ここで押し直せると、利用者が並べた覚えのない
        // 順序がそのまま本へ書かれる。読み直せる見込みは無いので、
        // 開き直してもらうしかない
        setStatus(
          `${written}。ページ一覧を読み直せませんでした（${reason}）。` +
            "別のファイルを選び直すか、開き直してください",
        );
        return;
      }
      // 断られた保存は 1 バイトも書いていない。並びはそのままで押し直せる
      setStatus(reason);
      setSaving(false);
    }
  };

  return (
    <EditorLayout
      toolbar={
        <>
          {/* 数えるのは、いま並べているページ。プロップの数を出すと、自分で
              書き込んで読み直した直後だけ画面と数が食い違う */}
          <span className="tabular shrink-0 text-[12px] text-ink-faint">
            {order.length} ページ
          </span>
          <Badge tone={dirty ? "warn" : "neutral"} data-testid="dirty-state">
            {dirty ? "未保存の変更があります" : "変更はありません"}
          </Badge>
          <span
            className="tabular shrink-0 text-[12px] text-ink-faint"
            data-testid="selection-count"
          >
            {selection.length} 件選択
          </span>
          {/* 画面固有の操作なので、共通ヘッダーではなく保存と同じ並びに置く。
              伸び縮みする status より左に置き、文字が増えてもつまみの位置が
              動かないようにする */}
          <label className="flex shrink-0 items-center gap-2 text-[12px] text-ink-muted">
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
          {/* 見出しの行は 1 行に固定してある。長い報告で折り返させず、
              全文は吹き出しで読めるようにする */}
          <span
            className="min-w-0 truncate text-[12px] text-ink-muted"
            data-testid="status"
            title={status}
          >
            {status}
          </span>
          <Button
            variant="secondary"
            className="shrink-0"
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
            className="shrink-0"
            data-testid="save"
            disabled={!dirty || saving}
            onClick={save}
          >
            <Save />
            ZIP に保存
          </Button>
        </>
      }
      hint={
        <>
          右から左へ読む順に並びます ・ ドラッグで順番を入れ替え ・{" "}
          <Key>Ctrl</Key>/<Key>Shift</Key>
          +クリックで複数選択 ・ <Key>Ctrl</Key>+<Key>Z</Key> で元に戻す ・
          虫眼鏡で原寸表示
        </>
      }
    >
      {/* スクロールするのは格子だけ。見出しの行は器の外側に固定される */}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="page-grid">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={order} strategy={rectSortingStrategy}>
            {/* 右綴じの本と同じく右から左へ並べる（#132）。左から右へ並べると、
                見開きを割った 2 ページ（右半分が先）が見開きと左右逆に並び、
                割った向きが逆に見える */}
            <div
              dir="rtl"
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
                  thumbnailUrl={`${client.thumbnailUrl(archive, name, cardWidth)}&v=${reloadKey}`}
                  onSelect={select}
                  onZoom={setZoomed}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {zoomed ? (
        <div
          className="fixed inset-0 z-40 flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-black/94 p-6"
          data-testid="lightbox"
          onClick={() => setZoomed(null)}
        >
          <img
            data-testid="lightbox-image"
            className="max-h-[82vh] max-w-[92vw] rounded shadow-2xl"
            // 原寸も同じ。開いたまま本が書き換わったとき、同じ名前で
            // 書き換わる前の絵を出し続けない
            src={`${client.imageUrl(archive, zoomed)}&v=${reloadKey}`}
            alt={zoomed}
          />
          <span className="text-[12px] text-ink-faint">
            {zoomed}（クリックまたは Esc で閉じる）
          </span>
        </div>
      ) : null}
    </EditorLayout>
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
