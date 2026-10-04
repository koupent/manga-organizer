import {
  Check,
  Columns2,
  Image as ImageIcon,
  ListOrdered,
  Package,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { SectionTitle } from "./ui/section-title";

/** 出来たファイルをそのまま開ける画面 */
export type HandoffMode = "thumbnail" | "reorder" | "split";

/** 本ごとの編集済みの種類（サイドカーの /api/edits）。鍵は本のパス */
export type EditMarks = Readonly<Record<string, readonly string[]>>;

/** 近道の並び。1 冊を編集する 3 画面と同じ順にする */
const SHORTCUTS: readonly {
  mode: HandoffMode;
  icon: LucideIcon;
  action: string;
}[] = [
  { mode: "thumbnail", icon: ImageIcon, action: "サムネイルを作る" },
  { mode: "reorder", icon: ListOrdered, action: "ページを並べ替える" },
  { mode: "split", icon: Columns2, action: "ページを分割・結合する" },
];

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
 * 行に載せる、文字の付いた小さなボタンの寸法（ファイルブラウザの行が使う）。
 *
 * 既定の 28px ではなく、アイコンだけのボタンと同じ 24px に揃える。行の高さを
 * 30px 以下に保つためと、主操作（32px）や画面の操作（28px）と高さで張り合わない
 * ようにするため。
 */
export const SHORTCUT_SIZE = "h-6 gap-1 px-1.5 text-[11.5px]";

type ProducedListProps = {
  paths: string[];
  /** 本ごとの編集済みの種類。近道のアイコンに印を出す */
  edits: EditMarks;
  onOpen: (path: string, mode: HandoffMode) => void;
};

/**
 * 1 冊を編集する 3 画面への近道（#143）。
 *
 * アイコンだけを並べ、何をするかはカーソルを乗せたときに出す。文字を添えると
 * 行が横に伸び、本の名前が削られる。寸法はアイコンだけのボタン（24px）で、
 * 行の高さを 30px 以下に保ち、主操作と高さで張り合わない。
 *
 * 編集済みの画面は緑にしてチェックを添える。整理済みの印と同じく、その本に
 * もう手を入れたかが一目で分かるようにする。そのため乗せる前から見せておく。
 *
 * 処理対象の一覧（`PlanList`）の整理済みの行も同じ近道を置く。同じことを
 * する近道が画面ごとに違う顔をしていると、押す前に読み直すことになる。
 */
export function EditShortcuts({
  name,
  path,
  edited,
  testIdPrefix,
  onOpen,
}: {
  name: string;
  /** 開く本。いまディスク上に在るファイル */
  path: string;
  edited: readonly string[];
  testIdPrefix: string;
  onOpen: (path: string, mode: HandoffMode) => void;
}) {
  return (
    <span className="flex shrink-0 items-center">
      {SHORTCUTS.map(({ mode, icon: Icon, action }) => {
        const done = edited.includes(mode);
        const label = `${name} の${action}${done ? "（編集済み）" : ""}`;
        return (
          <Button
            key={mode}
            variant="ghost"
            size="icon"
            className={cn("relative", done ? "text-ok" : "text-ink-faint")}
            data-testid={`${testIdPrefix}-to-${mode}`}
            data-edited={done}
            title={label}
            aria-label={label}
            onClick={() => onOpen(path, mode)}
          >
            <Icon />
            {done ? (
              <Check
                aria-hidden
                strokeWidth={4}
                className="absolute -top-0.5 -right-0.5 size-2.5! rounded-full bg-ok p-px text-surface"
              />
            ) : null}
          </Button>
        );
      })}
    </span>
  );
}

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
export function ProducedList({ paths, edits, onOpen }: ProducedListProps) {
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
          <ProducedItem
            key={path}
            path={path}
            edited={edits[path] ?? []}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

/** 出来たファイル 1 件。名前と、次の作業への近道を並べる */
function ProducedItem({
  path,
  edited,
  onOpen,
}: {
  path: string;
  edited: readonly string[];
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
      <EditShortcuts
        name={name}
        path={path}
        edited={edited}
        testIdPrefix="produced"
        onOpen={onOpen}
      />
    </li>
  );
}
