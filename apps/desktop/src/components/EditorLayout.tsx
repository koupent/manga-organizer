import type { ReactNode } from "react";

type EditorLayoutProps = {
  /** 見出しの行に並べる操作。高さは 1 行に固定される */
  toolbar: ReactNode;
  /** 操作の説明。見出しの下に 1 行で出す */
  hint?: ReactNode;
  /** 作業面。高さの決まった縦の flex の中に置かれる */
  children: ReactNode;
};

/** 見出しと操作説明を固定し、作業面だけをスクロールする編集画面の器。 */
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
