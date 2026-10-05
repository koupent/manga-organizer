import {
  Check,
  Columns2,
  Image as ImageIcon,
  ListOrdered,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

/** 整理した本をそのまま開ける画面 */
export type HandoffMode = "thumbnail" | "reorder" | "split";

/** 本ごとの編集済みの種類（サイドカーの /api/edits）。鍵は本のパス */
export type EditMarks = Readonly<Record<string, readonly string[]>>;

/** 近道の並び。1 冊を編集する 3 画面のタブと同じ順にする（#173） */
const SHORTCUTS: readonly {
  mode: HandoffMode;
  icon: LucideIcon;
  action: string;
}[] = [
  { mode: "thumbnail", icon: ImageIcon, action: "サムネイルを作る" },
  { mode: "split", icon: Columns2, action: "ページを分割・結合する" },
  { mode: "reorder", icon: ListOrdered, action: "ページを並べ替える" },
];

/**
 * 行に載せる、文字の付いた小さなボタンの寸法（ファイルブラウザの行が使う）。
 *
 * 既定の 28px ではなく、アイコンだけのボタンと同じ 24px に揃える。行の高さを
 * 30px 以下に保つためと、主操作（32px）や画面の操作（28px）と高さで張り合わない
 * ようにするため。
 */
export const SHORTCUT_SIZE = "h-6 gap-1 px-1.5 text-[11.5px]";

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
 * 置くのは処理対象の一覧（`PlanList`）の整理済みの行。整理して出来た本の
 * 行にも、出来た時点から置く（#160）。
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
