import { cn } from "../lib/utils";
import type { SidecarClient } from "../api/client";

/** 見本の幅。原寸を並べると読み込みが重い */
const CANDIDATE_WIDTH = 120;

type CoverCandidatesProps = {
  client: SidecarClient;
  archive: string;
  pages: string[];
  /** いま選ばれている 1 枚 */
  current: string;
  /** 加工しても名前は変わらないことがある。画像キャッシュを外す鍵 */
  reloadKey: number;
  onSelect: (name: string) => void;
};

/**
 * サムネイルにする 1 枚を選ぶ候補一覧。
 *
 * 絵の上ではなく作業面の下に、高さの決まった帯として敷く。候補は絵と
 * 見比べるためのものなので、開いた瞬間に肝心の絵が押し下げられたり
 * 縮んだりしては選べない。横に流し、縦は絵に譲る。
 */
export function CoverCandidates({
  client,
  archive,
  pages,
  current,
  reloadKey,
  onSelect,
}: CoverCandidatesProps) {
  return (
    <section
      className="flex h-28 shrink-0 flex-col gap-1"
      data-testid="page-candidates"
    >
      <span className="text-[11.5px] text-ink-muted">
        サムネイルにする 1 枚を選ぶと、確定したときに先頭ページへ移ります
      </span>
      <ul className="flex min-h-0 flex-1 gap-2 overflow-x-auto">
        {pages.map((name) => (
          <li key={name} className="h-full">
            <button
              type="button"
              data-testid="thumbnail-candidate"
              data-name={name}
              aria-pressed={name === current}
              className={cn(
                "flex h-full w-20 flex-col items-center gap-1 rounded border p-1",
                name === current
                  ? "border-brand bg-brand/10"
                  : "border-line hover:border-line-strong",
              )}
              onClick={() => onSelect(name)}
            >
              <img
                className="min-h-0 w-full flex-1 rounded object-contain"
                src={`${client.thumbnailUrl(archive, name, CANDIDATE_WIDTH)}&v=${reloadKey}`}
                alt={name}
              />
              <span className="w-full truncate text-[11px] text-ink-muted">
                {name}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
