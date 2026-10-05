import {
  BookMarked,
  Check,
  ChevronDown,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AuthorSource, Candidate } from "../../hooks/useAuthorLookup";
import { nameHint } from "../../lib/organize-text";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SectionTitle } from "../ui/section-title";

type SeriesInfoSectionProps = {
  title: string;
  author: string;
  authorSource: AuthorSource;
  candidates: Candidate[];
  searching: boolean;
  /** 投入したものの件数。0 件なら欄の役目を先に言う */
  sourceCount: number;
  /** 実際に何かが作られる単位の数 */
  keptLeafCount: number;
  /** そのうち自分の名前を持たない本の数 */
  namelessCount: number;
  /** 作品名・著者が要るのに空か。空のままでは整理を始められない（#175） */
  titleMissing: boolean;
  authorMissing: boolean;
  onChangeTitle: (next: string) => void;
  onTypeAuthor: (next: string) => void;
  onChooseAuthor: (next: string) => void;
  onOpenLibrary: () => void;
};

/**
 * 作品情報の区画。
 *
 * 作品名と著者は、出来る本の名前を組み立てる材料。打つと著者が勝手に
 * 埋まるので、どこから来た著者なのかを色と data-source で示す。
 *
 * 区画の高さは変えない（左の列の 3 段のうち上の段）。検索の候補は著者欄に
 * ぶら下げて重ねて出し、下の投入の箱を押し下げない。
 */
export function SeriesInfoSection({
  title,
  author,
  authorSource,
  candidates,
  searching,
  sourceCount,
  keptLeafCount,
  namelessCount,
  titleMissing,
  authorMissing,
  onChangeTitle,
  onTypeAuthor,
  onChooseAuthor,
  onOpenLibrary,
}: SeriesInfoSectionProps) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(candidates);
  const box = useRef<HTMLDivElement>(null);
  const authorInput = useRef<HTMLInputElement>(null);

  // 候補が届いたとき、今の著者と違うものが 1 つでもあれば開いて見せる。
  // 著者に入った 1 件だけなら選び直す相手が無いので開かない
  if (candidates !== seen) {
    setSeen(candidates);
    setOpen(candidates.some((candidate) => candidate.author !== author));
  }

  // 外を押したとき・焦点が外へ出たとき（Tab で離れたとき）に閉じる。
  // 押した先の操作はそのまま効かせる
  useEffect(() => {
    const area = box.current;
    if (!open || !area) return;
    const closeOutside = (event: PointerEvent) => {
      if (!area.contains(event.target as Node)) setOpen(false);
    };
    const closeOnLeave = (event: FocusEvent) => {
      if (!area.contains(event.relatedTarget as Node | null)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    area.addEventListener("focusout", closeOnLeave);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      area.removeEventListener("focusout", closeOnLeave);
    };
  }, [open]);

  const choose = (next: string) => {
    onChooseAuthor(next);
    setOpen(false);
    authorInput.current?.focus();
  };

  const handleKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      authorInput.current?.focus();
    }
    // 著者欄から ↓ で開き、先頭の候補へ移る
    if (
      event.key === "ArrowDown" &&
      event.target === authorInput.current &&
      candidates.length > 0
    ) {
      event.preventDefault();
      setOpen(true);
      requestAnimationFrame(() =>
        box.current
          ?.querySelector<HTMLButtonElement>('[data-testid="author-candidate"]')
          ?.focus(),
      );
    }
  };

  return (
    <section className="flex shrink-0 flex-col gap-2" data-testid="series-info">
      <div className="flex h-7 items-center gap-2">
        <SectionTitle>作品情報</SectionTitle>
        {/* 左の列が何に使われるかを添える。文言だけが替わり、高さは変わらない */}
        <span
          className="min-w-0 truncate text-[11px] text-ink-faint"
          data-testid="organize-name-hint"
          title={nameHint(sourceCount, keptLeafCount, namelessCount)}
        >
          {nameHint(sourceCount, keptLeafCount, namelessCount)}
        </span>
        <div className="flex-1" />
        <Button data-testid="open-library" onClick={onOpenLibrary}>
          <BookMarked />
          辞書
        </Button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-muted">
          作品名
          {titleMissing ? <MissingMark /> : null}
        </span>
        <Input
          value={title}
          aria-invalid={titleMissing || undefined}
          className={cn(titleMissing && "border-warn")}
          list="known-titles"
          placeholder="作品名を入れると著者を探します"
          data-testid="organize-title"
          onChange={(event) => onChangeTitle(event.target.value)}
        />
      </label>

      <div ref={box} className="relative flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-muted">
            著者
            {authorMissing && !searching ? <MissingMark /> : null}
            {searching ? (
              <span
                className="flex items-center gap-1 text-ink-faint"
                data-testid="author-searching"
              >
                <Loader2 className="size-3 animate-spin" />
                検索中
              </span>
            ) : null}
          </span>
          <Input
            ref={authorInput}
            value={author}
            // 候補を出している間は入力の候補（datalist）を外す。WebView2 では
            // 両方が同時に開いて重なる
            list={candidates.length > 0 ? undefined : "known-authors"}
            placeholder="著者"
            data-testid="organize-author"
            data-source={authorSource}
            aria-invalid={authorMissing || undefined}
            className={cn(
              authorSource === "library" && "text-brand",
              authorMissing && "border-warn",
              candidates.length > 0 && "pr-20",
            )}
            onKeyDown={handleKey}
            onChange={(event) => {
              setOpen(false);
              onTypeAuthor(event.target.value);
            }}
          />
        </label>

        {candidates.length > 0 ? (
          <Button
            size="icon"
            data-testid="author-candidates-toggle"
            aria-expanded={open}
            title="検索で見つかった著者の候補"
            className={cn(
              "absolute right-0.5 bottom-0.5 w-auto px-1.5 text-[11.5px]",
              open && "border-brand",
            )}
            onClick={() => setOpen((current) => !current)}
            onKeyDown={handleKey}
          >
            候補 {candidates.length}
            <ChevronDown />
          </Button>
        ) : null}

        {open && candidates.length > 0 ? (
          <div
            className="absolute inset-x-0 top-full z-20 mt-1 rounded-card border border-line bg-canvas p-1 shadow-lg"
            data-testid="author-candidates"
          >
            <p className="flex h-5 items-center px-2 text-[11px] text-ink-faint">
              検索結果 {candidates.length} 件 · 近い順
            </p>
            <ul className="max-h-[140px] overflow-y-auto">
              {candidates.map((candidate) => (
                <li key={candidate.author}>
                  <button
                    type="button"
                    data-testid="author-candidate"
                    data-author={candidate.author}
                    title={`${candidate.title}（${candidate.source}）`}
                    className={cn(
                      "flex h-7 w-full items-center gap-2 rounded-control px-2 text-left outline-none",
                      "hover:bg-surface-2 focus-visible:bg-surface-2",
                      candidate.author === author && "text-brand",
                    )}
                    onClick={() => choose(candidate.author)}
                    onKeyDown={handleKey}
                  >
                    <Check
                      className={cn(
                        "size-3.5 shrink-0",
                        candidate.author !== author && "invisible",
                      )}
                    />
                    <span className="shrink-0 text-[12.5px] font-medium">
                      {candidate.author}
                    </span>
                    <span className="min-w-0 truncate text-[11.5px] text-ink-faint">
                      {candidate.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * 空のままでは整理を始められない欄に添える印（#175）。押せない理由は
 * 主操作の横にも出るが、そこだけだと解析が終わっていないのと見分けにくい
 */
function MissingMark() {
  return (
    <span
      className="flex items-center gap-1 text-warn"
      data-testid="organize-missing"
    >
      <TriangleAlert className="size-3" />
      入れてください
    </span>
  );
}
