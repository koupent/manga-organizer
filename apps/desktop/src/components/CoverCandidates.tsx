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
 * 切り抜きの面と入れ替わりで、同じ作業面を丸ごと受け取って格子に並べる。
 * 単行本は 150〜200 ページある。1 行の帯では中ほどのページへ辿り着けず、
 * 横へ流しても目的の 1 枚がどこにあるか見当が付かない。
 * 選んでいる間は切り抜きを触れないが、見比べる必要は薄い。
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
      className="flex min-h-0 flex-1 flex-col gap-1"
      data-testid="page-candidates"
    >
      <span className="shrink-0 text-[11.5px] text-ink-muted">
        サムネイルにする 1 枚を選ぶと、確定したときに先頭ページへ移ります
      </span>
      <ul
        className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${CANDIDATE_WIDTH}px, 1fr))`,
        }}
      >
        {pages.map((name) => (
          <li key={name}>
            <button
              type="button"
              data-testid="thumbnail-candidate"
              data-name={name}
              aria-pressed={name === current}
              className={cn(
                "flex w-full flex-col items-center gap-1 rounded border p-1",
                name === current
                  ? "border-brand bg-brand/10"
                  : "border-line hover:border-line-strong",
              )}
              onClick={() => onSelect(name)}
            >
              <img
                className="aspect-2/3 w-full rounded bg-canvas object-contain"
                src={`${client.thumbnailUrl(archive, name, CANDIDATE_WIDTH)}&v=${reloadKey}`}
                alt={name}
                loading="lazy"
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
