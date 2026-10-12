import { useState } from "react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";

const MODES = [
  {
    id: "trim",
    title: "余白カット",
    text: "全ページに共通する余白を取り除きます。",
    action: "検出結果を確認し、切り取り量と対象ページを調整します。",
  },
  {
    id: "split",
    title: "ページ分割",
    text: "横長の見開きを2ページに分けます。",
    action:
      "分けたい画像にチェックを入れ、分割線をドラッグして位置を調整します。",
  },
  {
    id: "merge",
    title: "ページ結合",
    text: "隣り合う2ページを見開きにします。",
    action:
      "候補の「結合」を押します。手動で選ぶときはページ右下の「結合…」から相手を指定します。",
  },
] as const;

function Illustration({ mode }: { mode: (typeof MODES)[number]["id"] }) {
  const pattern = `guide-${mode}`;
  return (
    <svg
      viewBox="0 0 260 145"
      aria-hidden
      className="w-full rounded-control bg-surface-2"
    >
      <defs>
        <pattern
          id={pattern}
          width="42"
          height="48"
          patternUnits="userSpaceOnUse"
        >
          <rect
            x="3"
            y="3"
            width="36"
            height="42"
            rx="2"
            fill="#fff"
            stroke="#748198"
          />
          <path
            d="M6 34 17 20 25 29 32 18 36 23M9 11h15"
            fill="none"
            stroke="#748198"
            strokeWidth="2"
          />
        </pattern>
      </defs>
      <path
        d="M119 70h22m-7-6 7 6-7 6"
        fill="none"
        stroke="#6095ff"
        strokeWidth="3"
      />
      {mode === "trim" ? (
        <>
          <rect
            x="16"
            y="14"
            width="84"
            height="116"
            rx="3"
            fill="#fff"
            stroke="#748198"
          />
          <rect
            x="29"
            y="28"
            width="58"
            height="88"
            fill={`url(#${pattern})`}
          />
          <rect
            x="27"
            y="26"
            width="62"
            height="92"
            fill="none"
            stroke="#6095ff"
            strokeWidth="2"
            strokeDasharray="4 3"
          />
          <rect
            x="170"
            y="26"
            width="62"
            height="92"
            rx="3"
            fill={`url(#${pattern})`}
            stroke="#6095ff"
            strokeWidth="2"
          />
        </>
      ) : mode === "split" ? (
        <>
          <rect
            x="10"
            y="31"
            width="98"
            height="80"
            rx="3"
            fill={`url(#${pattern})`}
            stroke="#748198"
          />
          <path
            d="M59 26v90"
            stroke="#6095ff"
            strokeWidth="2"
            strokeDasharray="4 3"
          />
          <rect
            x="158"
            y="31"
            width="42"
            height="80"
            rx="3"
            fill={`url(#${pattern})`}
            stroke="#6095ff"
          />
          <rect
            x="210"
            y="31"
            width="42"
            height="80"
            rx="3"
            fill={`url(#${pattern})`}
            stroke="#6095ff"
          />
        </>
      ) : (
        <>
          <rect
            x="10"
            y="31"
            width="42"
            height="80"
            rx="3"
            fill={`url(#${pattern})`}
            stroke="#748198"
          />
          <rect
            x="62"
            y="31"
            width="42"
            height="80"
            rx="3"
            fill={`url(#${pattern})`}
            stroke="#748198"
          />
          <rect
            x="156"
            y="31"
            width="96"
            height="80"
            rx="3"
            fill={`url(#${pattern})`}
            stroke="#6095ff"
            strokeWidth="2"
          />
          <path d="M204 32v78" stroke="#6095ff" strokeDasharray="3 3" />
        </>
      )}
    </svg>
  );
}

export function EditorGuide({ onClose }: { onClose: (hide: boolean) => void }) {
  const [hide, setHide] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose(hide);
      }}
    >
      <DialogContent className="gap-4 p-5" data-testid="editor-guide">
        <div>
          <DialogTitle className="text-base font-semibold text-ink">
            ファイル編集の使い方
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-ink-muted">
            ページ一覧を見ながら、必要な加工を選べます。余白がある本は、分割・結合の前に余白カットを行うと便利です。
          </DialogDescription>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {MODES.map((mode, index) => (
            <section key={mode.id} className="min-w-0 space-y-2">
              <Illustration mode={mode.id} />
              <h3 className="font-semibold text-ink">
                <span className="mr-1.5 text-brand">{index + 1}.</span>
                {mode.title}
              </h3>
              <p className="text-sm text-ink">{mode.text}</p>
              <p className="text-sm leading-relaxed text-ink-muted">
                {mode.action}
              </p>
            </section>
          ))}
        </div>
        <p className="rounded-control border border-line bg-surface-2 p-3 text-sm text-ink-muted">
          自動検出は目安です。対象を確認して不要なチェックを外し、各モードの右上の「反映」ボタンで保存します。モードは自由に切り替えられます。
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
            <Checkbox
              checked={hide}
              onCheckedChange={(checked) => setHide(checked === true)}
            />
            今後表示しない
          </label>
          <Button variant="primary" size="lg" onClick={() => onClose(hide)}>
            編集を始める
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
