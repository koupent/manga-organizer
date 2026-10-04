import type { ReactNode } from "react";

type EditorLayoutProps = {
  /** 見出しの行に並べる操作。高さは 1 行に固定される */
  toolbar: ReactNode;
  /** 操作の説明。見出しの下に 1 行で出す */
  hint?: ReactNode;
  /** 作業面。高さの決まった縦の flex の中に置かれる */
  children: ReactNode;
};

/**
 * 1 冊を編集する 3 画面（サムネイル作成・ページ並べ替え・ページ分割）の器（#129）。
 *
 * 見出しの行は固定し、作業面だけが自分の高さの中でスクロールする。器を画面ごとに
 * 書き写していた頃は、ページ並べ替えだけが作業面ごと窓をスクロールさせ、
 * 保存や表示サイズの操作が画面の外へ流れた。ここを通せば、見出しは作業面の
 * 外にあるので流れようがない。
 *
 * 作業面の中でどこをスクロールさせるかは各画面が決める。格子は格子ごと、
 * サムネイル作成は右の列だけ、と流したい所が画面ごとに違うため。
 */
export function EditorLayout({ toolbar, hint, children }: EditorLayoutProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 高さを固定する。文が入れ替わるたびに折り返して作業面が押し下がると、
          いま見ていたページが視界から外れる */}
      <div className="flex h-7 shrink-0 items-center gap-2">{toolbar}</div>
      {hint ? (
        <p className="shrink-0 text-[11.5px] leading-[18px] text-ink-faint">
          {hint}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}
