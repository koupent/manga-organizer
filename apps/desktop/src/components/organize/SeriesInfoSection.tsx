import { BookMarked, Loader2 } from "lucide-react";
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
  /** 整理済みの行が一覧に在るか。無いときは但し書きを出さない */
  hasOrganized: boolean;
  /** 実際に何かが作られる単位の数 */
  keptLeafCount: number;
  /** そのうち自分の名前を持たない本の数 */
  namelessCount: number;
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
 */
export function SeriesInfoSection({
  title,
  author,
  authorSource,
  candidates,
  searching,
  hasOrganized,
  keptLeafCount,
  namelessCount,
  onChangeTitle,
  onTypeAuthor,
  onChooseAuthor,
  onOpenLibrary,
}: SeriesInfoSectionProps) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionTitle>作品情報</SectionTitle>
        {/* 整理済みの行があるときだけ、左の列が何に使われるかを添える */}
        {hasOrganized ? (
          <span
            className="min-w-0 truncate text-[11px] text-ink-faint"
            data-testid="organize-name-hint"
          >
            {nameHint(keptLeafCount, namelessCount)}
          </span>
        ) : null}
        <div className="flex-1" />
        <Button data-testid="open-library" onClick={onOpenLibrary}>
          <BookMarked />
          辞書
        </Button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11.5px] font-medium text-ink-muted">作品名</span>
        <Input
          value={title}
          list="known-titles"
          placeholder="作品名を入れると著者を探します"
          data-testid="organize-title"
          onChange={(event) => onChangeTitle(event.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-muted">
          著者
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
          value={author}
          list="known-authors"
          placeholder="著者"
          data-testid="organize-author"
          data-source={authorSource}
          className={authorSource === "library" ? "text-brand" : undefined}
          onChange={(event) => onTypeAuthor(event.target.value)}
        />
      </label>

      {candidates.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-1.5"
          data-testid="author-candidates"
        >
          <span className="text-[11.5px] text-ink-faint">検索結果</span>
          {candidates.map((candidate) => (
            <button
              key={candidate.author}
              type="button"
              data-testid="author-candidate"
              data-author={candidate.author}
              title={`${candidate.title}（${candidate.source}）`}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11.5px] transition-colors",
                candidate.author === author
                  ? "border-brand bg-brand/10 text-brand"
                  : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
              )}
              onClick={() => onChooseAuthor(candidate.author)}
            >
              {candidate.author}
              <span className="ml-1 text-ink-faint">{candidate.title}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
