import { Image as ImageIcon, ListOrdered, Package } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { SectionTitle } from "./ui/section-title";

/** 出来たファイルをそのまま開ける画面 */
export type HandoffMode = "thumbnail" | "reorder";

/**
 * 一覧の高さの上限。
 *
 * 中身の量で伸ばさない。1 回に整理する冊数は決まっておらず、多いときに
 * 処理対象の一覧や処理ログを押し縮めてしまうため。溢れた行はこの中で
 * スクロールする。4 行ぶんより少し高くしてあるのは、次の行の頭が覗いて
 * 「まだ続きがある」と分かるようにするため。
 */
const LIST_MAX_HEIGHT = "max-h-[120px]";

/**
 * 行に載せる近道のボタンの寸法。
 *
 * 既定の 28px ではなく、アイコンだけのボタンと同じ 24px に揃える。
 * 行の高さを 30px 以下に保つためと、主操作（32px）や画面の操作（28px）と
 * 高さで張り合わないようにするため。近道は主役ではない。
 */
const SHORTCUT_SIZE = "h-6 gap-1 px-1.5 text-[11.5px]";

type ProducedListProps = {
  paths: string[];
  onOpen: (path: string, mode: HandoffMode) => void;
};

/**
 * 整理して出来たファイルの一覧。
 *
 * 3 つの機能はそれぞれ単独で完結するのが主で、ここは任意の近道でしかない。
 * だから整理が成功したときだけ出し、それ以外では何も描かない（実行前・
 * 失敗後に空を渡すのは呼び出し側の役目）。
 *
 * 押した行のファイルを次の画面へそのまま読み込ませ、出力先を辿り直して
 * 同じファイルを選ぶ手間だけを省く。行が持つのは元のファイルではなく
 * 整理後の絶対パスで、名前も中身も付け替わった後のものを指す。
 */
export function ProducedList({ paths, onOpen }: ProducedListProps) {
  if (paths.length === 0) return null;

  return (
    <section
      className="flex shrink-0 flex-col gap-1"
      data-testid="produced-list"
    >
      <div className="flex items-center gap-1.5">
        <SectionTitle>出来たファイル</SectionTitle>
        <span className="tabular text-[11.5px] text-ink-faint">
          {paths.length} 冊
        </span>
      </div>

      <ul
        className={cn(
          "divide-y divide-line/60 overflow-y-auto rounded-card border border-line bg-surface",
          LIST_MAX_HEIGHT,
        )}
      >
        {paths.map((path) => (
          <ProducedItem key={path} path={path} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

/** 出来たファイル 1 件。名前と、次の作業への近道を並べる */
function ProducedItem({
  path,
  onOpen,
}: {
  path: string;
  onOpen: (path: string, mode: HandoffMode) => void;
}) {
  // 出すのは名前だけにする。整理後の置き場所は「[著者] 作品名/」で
  // 決まっていて全行同じになり、並べても行が読みにくくなるだけ。
  // 実際にどこへ出来たのかは title で確かめられるようにしておく
  const name = path.split("/").pop() ?? path;

  return (
    <li
      className="flex items-center gap-2 px-2 py-0.5"
      data-testid="produced-item"
      data-path={path}
    >
      <Package className="size-3.5 shrink-0 text-ink-faint" />
      <span
        className="min-w-0 flex-1 truncate text-[12.5px]"
        data-testid="produced-name"
        title={path}
      >
        {name}
      </span>
      <Button
        variant="ghost"
        className={SHORTCUT_SIZE}
        data-testid="produced-to-thumbnail"
        title={`${name} のサムネイルを作る`}
        onClick={() => onOpen(path, "thumbnail")}
      >
        <ImageIcon />
        サムネイル
      </Button>
      <Button
        variant="ghost"
        className={SHORTCUT_SIZE}
        data-testid="produced-to-reorder"
        title={`${name} のページを並べ替える`}
        onClick={() => onOpen(path, "reorder")}
      >
        <ListOrdered />
        ページ
      </Button>
    </li>
  );
}
