import { BookOpen, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./lib/utils";
import { parentDirectory } from "./path";
import { SidecarClient } from "./api/client";
import { CoverEditor } from "./components/CoverEditor";
import { FilePicker } from "./components/FilePicker";
import { PageGrid } from "./components/PageGrid";
import { OrganizePanel } from "./components/OrganizePanel";
import { SplitEditor } from "./components/SplitEditor";
import type { HandoffMode } from "./components/ProducedList";
import { onFilesDropped, resolveConnection } from "./connection";
import { Alert } from "./components/ui/alert";
import { Segmented } from "./components/ui/segmented";

type Page = { name: string; size: number; modified: string };
type Mode = "organize" | "reorder" | "thumbnail" | "split";

// 対象物ではなく、そこで何ができるかでタブを名付ける
// 使う順に並べる。整理はほぼ必ず通り、サムネイルは良し悪しが一目で分かる。
// ページ順の異常は読んで初めて気づくもので、後から戻ってくる使い方が主になる。
// 見開きを割るのは、順序を直し終えてから最後に通る
const MODES: { id: Mode; label: string }[] = [
  { id: "organize", label: "ファイル整理" },
  { id: "thumbnail", label: "サムネイル作成" },
  { id: "reorder", label: "ページ並べ替え" },
  { id: "split", label: "ページ分割" },
];

/** 1 冊を読み込んで使う画面。アーカイブが書き換わると中身が古くなる */
type ArchiveMode = "thumbnail" | "reorder" | "split";

/**
 * 画面ごとの「読み直しの世代」。
 *
 * どれか 1 つがアーカイブを書き換えると、ページ名もページ数も変わる。他の画面が
 * 抱えているページは、その瞬間に別の本のものになる。世代を進めて作り直させる。
 *
 * 書いた画面自身は進めない。自分の結果は自分で読み直しているうえ、作り直すと
 * 「何をしたか」の報告ごと消える。利用者は押した結果を確かめられなくなる。
 */
type ArchiveVersions = Record<ArchiveMode, number>;

const FIRST_VERSIONS: ArchiveVersions = { thumbnail: 0, reorder: 0, split: 0 };

function staleAfter(
  current: ArchiveVersions,
  writer: ArchiveMode,
): ArchiveVersions {
  return {
    thumbnail: current.thumbnail + (writer === "thumbnail" ? 0 : 1),
    reorder: current.reorder + (writer === "reorder" ? 0 : 1),
    split: current.split + (writer === "split" ? 0 : 1),
  };
}

/** 対象を選ぶ画面の見出し。どの作業のために選ぶのかを言う */
const PICKER_TITLES: Record<ArchiveMode, string> = {
  reorder: "並べ替えるアーカイブ",
  thumbnail: "サムネイルを作るアーカイブ",
  split: "ページを分割するアーカイブ",
};

const isArchiveMode = (mode: Mode): mode is ArchiveMode => mode !== "organize";

const isMode = (value: string | null): value is Mode =>
  MODES.some((item) => item.id === value);

/**
 * 起動時のクエリ文字列。
 *
 * 窓の中で移動しないので、読むのは最初の描画の一度きりでよい。効果ではなく
 * 初期値として読むのは、どの画面をどのファイルで開くかが最初の描画から
 * 決まっている必要があるため。後から入れ直すと、その前に既定の画面を
 * 一度作ってしまう。
 */
const startupParams = () => new URLSearchParams(window.location.search);

/**
 * 画面ひとつぶんの入れ物。見えていない間も中身を捨てない。
 *
 * 隠すのに display:none を使う。画面の外へ逃がす・透明にするといった、
 * 描画が生きたままの隠し方では、隠れている格子の img が残りのサムネイルを
 * 取りに行ってしまう。display:none の中は配置そのものが行われないので、
 * loading="lazy" の img は表示領域に入らず取りに行かない。高さも取らないため、
 * 見えている画面の寸法にも影響しない。
 *
 * 見えている間は display:contents にして、この入れ物自体を配置から消す。
 * 箱を 1 枚挟むと、パネルが作業面の flex の子であるという前提が崩れる。
 */
function Panel({ active, children }: { active: boolean; children: ReactNode }) {
  return <div className={active ? "contents" : "hidden"}>{children}</div>;
}

/** ファイル整理・サムネイル作成・ページ並べ替え・ページ分割を切り替えて使う */
export function App() {
  const [client, setClient] = useState<SidecarClient | null>(null);
  const [mode, setMode] = useState<Mode>(() => {
    const requested = startupParams().get("mode");
    return isMode(requested) ? requested : "reorder";
  });
  const [archive, setArchive] = useState(
    () => startupParams().get("archive") ?? "",
  );
  const [pages, setPages] = useState<Page[]>([]);
  const [error, setError] = useState("");
  const [health, setHealth] = useState("");
  const [versions, setVersions] = useState<ArchiveVersions>(FIRST_VERSIONS);

  /**
   * 一度でも開いた画面。開いた画面は隠すだけで捨てず、状態を残す。
   *
   * まだ開いていない画面は作らない。作れば、利用者が一度も見ていない画面の
   * 読み込みや監視が裏で走る。
   */
  const [opened, setOpened] = useState<Mode[]>(() => [mode]);

  const [sources, setSources] = useState<string[]>([]);
  const [outputDirectory, setOutputDirectory] = useState(
    () => startupParams().get("output") ?? "",
  );

  // ドロップの購読は起動時の一度きりなので、最新の状態は ref から読む
  const sourcesRef = useRef<string[]>([]);
  sourcesRef.current = sources;
  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;

  /**
   * 処理対象の一覧を差し替える。
   *
   * 空の一覧に最初のファイルが入ったときは、その置き場所を出力先の既定にする。
   * 整理後の置き場所は元と同じ所であることがほとんどで、毎回選ばせる必要が
   * 無いため（元の Tkinter 版 main_window.py:225-230 と同じ）。
   * 既に入っている出力先は利用者が決めたものなので上書きしない。
   * ドロップと画面のどちらから足しても同じ既定になるよう、一覧を持つ
   * ここでまとめて面倒を見る。
   */
  const changeSources = (paths: string[]) => {
    if (sourcesRef.current.length === 0 && paths.length > 0) {
      setOutputDirectory((current) => current || parentDirectory(paths[0]));
    }
    setSources(paths);
  };

  /**
   * どれかの画面がアーカイブを書き換えた。
   *
   * ページ名もページ数も変わるので、他の画面が抱えているページは古い。
   * 世代を進めて作り直させる。
   */
  const archiveChanged = (writer: ArchiveMode) =>
    setVersions((current) => staleAfter(current, writer));

  /** 画面を移る。移った先は初回だけ作り、以後は隠すだけで捨てない */
  const changeMode = (next: Mode) => {
    setMode(next);
    setOpened((current) =>
      current.includes(next) ? current : [...current, next],
    );
  };

  /**
   * ページ並べ替え・サムネイル作成の対象を差し替える。
   *
   * 前の対象のページを残したまま次を読み込むと、並べ替え途中の順序が
   * 別のファイルへ持ち越される。空にしてから読み直し、編集ごと捨てる。
   *
   * 対象が変われば別の本なので、表紙も並べ替えも作り直しになる。作り直しに
   * なる画面は隠れたまま抱えても残せる状態が無く、読み込みだけが走る。
   * keep（移った先の画面）とファイル整理だけを残し、他は一旦落とす。
   */
  const changeArchive = (path: string, keep: Mode = modeRef.current) => {
    setPages([]);
    setArchive(path);
    setError("");
    setOpened((current) =>
      current.filter((item) => item === "organize" || item === keep),
    );
  };

  /**
   * 指定したファイルを読み込んだ状態で、その画面へ移る。
   *
   * ファイル整理で出来たファイルから次の作業へ移るための近道。対象と画面を
   * 同時に決めるので、移った先で選び直す必要がない。対象を先に入れてから
   * 画面を切り替えるのではなく一度に済ませるのは、対象の無い状態を経由すると
   * 移った先で一瞬ファイル選択が出てしまうため。
   *
   * 各機能は今までどおり単独でも使える。ここを通らなければ、移った先の
   * 見た目も振る舞いも従来のままになる。
   */
  const openArchiveIn = (path: string, next: HandoffMode) => {
    changeArchive(path, next);
    changeMode(next);
  };

  useEffect(() => {
    let cancelled = false;
    resolveConnection()
      .then((connection) => {
        if (cancelled) return;
        if (!connection) {
          setError("サイドカーへの接続情報がありません");
          return;
        }
        const created = new SidecarClient(connection);
        setClient(created);
        created
          .health()
          .then((payload) => setHealth(payload.status))
          .catch((reason) => setError(String(reason.message ?? reason)));
      })
      .catch((reason) => setError(String(reason.message ?? reason)));

    // ネイティブ側で受けたドロップは、いま見ている画面の入力にする。
    // 別のタブへ勝手に連れて行かれるより、落とした先で受かる方が素直
    const pending = onFilesDropped((paths) => {
      if (isArchiveMode(modeRef.current)) {
        // どれも 1 冊ずつしか扱えない。まとめて落とされたら先頭を採る
        if (paths.length > 0) changeArchive(paths[0]);
        return;
      }
      changeMode("organize");
      changeSources([...new Set([...sourcesRef.current, ...paths])]);
    });

    return () => {
      cancelled = true;
      pending.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!client || !archive || mode !== "reorder") return;
    setError("");
    client
      .listPages(archive)
      .then((payload) => setPages(payload.pages as Page[]))
      .catch((reason) => setError(String(reason.message ?? reason)));
  }, [client, archive, mode, versions.reorder]);

  const archiveName = archive ? (archive.split("/").pop() ?? archive) : "";

  return (
    /* 窓の高さを枠として使う。文書が窓より伸びると、下にある主操作を
       スクロールで探しに行くことになり、道具として使えなくなる */
    <main className="flex h-screen flex-col overflow-hidden">
      {/* 高さを 40px に固定する。中身の寸法に任せると、部品を 1 つ足すたびに
          ヘッダーが伸びて作業面が削れる。作業面の取り分を先に決めておく */}
      <header className="flex h-10 shrink-0 items-center gap-4 border-b border-line bg-surface/95 px-4">
        <div className="flex items-center gap-2">
          <BookOpen className="size-4 text-brand" />
          <h1 className="text-[13.5px] font-semibold tracking-tight">
            Manga Organizer
          </h1>
        </div>

        <Segmented
          items={MODES.map((m) => ({ ...m, testId: `mode-${m.id}` }))}
          value={mode}
          onChange={changeMode}
        />

        <div className="flex-1" />

        <span
          className="flex items-center gap-1.5 text-[11.5px] text-ink-faint"
          data-testid="connection"
          data-state={health === "ok" ? "ok" : "off"}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              health === "ok" ? "bg-ok" : "bg-ink-faint",
            )}
          />
          {health === "ok" ? "接続済み" : "未接続"}
        </span>
      </header>

      {/* 中央寄せの上限を置かない。広い窓では左右に余白が積み上がるだけで、
          その間ずっと入力欄や一覧は狭いまま使うことになる。
          溢れたときにスクロールするのはこの中であって、窓ではない */}
      <div className="flex min-h-0 w-full flex-1 flex-col gap-2 overflow-y-auto p-3">
        {error ? (
          <Alert tone="danger" data-testid="error">
            <TriangleAlert />
            <span>{error}</span>
          </Alert>
        ) : null}

        {/* 一度開いた画面は、別の画面へ移っても作り直さない。作品名も
            並べ替えの途中経過も切り抜き枠も、戻ってくればそのまま続けられる */}
        {opened.includes("organize") && client ? (
          <Panel active={mode === "organize"}>
            <OrganizePanel
              active={mode === "organize"}
              client={client}
              sources={sources}
              onSourcesChange={changeSources}
              outputDirectory={outputDirectory}
              onOutputDirectoryChange={setOutputDirectory}
              onOpenProduced={openArchiveIn}
            />
          </Panel>
        ) : null}

        {opened.includes("thumbnail") && client && archive ? (
          <Panel active={mode === "thumbnail"}>
            <CoverEditor
              // 対象が変われば別の表紙。選んだ 1 枚も切り抜き枠も作り直す。
              // 別の画面が本を書き換えたときも、抱えている 1 枚は別物になる
              key={`${archive}:${versions.thumbnail}`}
              client={client}
              archive={archive}
              archiveName={archiveName}
              onChangeArchive={() => changeArchive("")}
              onArchiveChanged={() => archiveChanged("thumbnail")}
            />
          </Panel>
        ) : null}

        {opened.includes("reorder") && client && archive && pages.length > 0 ? (
          <Panel active={mode === "reorder"}>
            <PageGrid
              // 対象が変われば別の本。並べ替えの途中経過ごと作り直す
              key={`${archive}:${versions.reorder}`}
              active={mode === "reorder"}
              client={client}
              archive={archive}
              archiveName={archiveName}
              pages={pages}
              onChangeArchive={() => changeArchive("")}
              onArchiveChanged={() => archiveChanged("reorder")}
            />
          </Panel>
        ) : null}

        {opened.includes("split") && client && archive ? (
          <Panel active={mode === "split"}>
            <SplitEditor
              key={`${archive}:${versions.split}`}
              client={client}
              archive={archive}
              archiveName={archiveName}
              onChangeArchive={() => changeArchive("")}
              onArchiveChanged={() => archiveChanged("split")}
            />
          </Panel>
        ) : null}

        {/* 1 冊を読み込んで使う 3 つの画面は、同じ入り口から投入する。
            実パスの引き当てのような壊れやすい所を三重に抱えない */}
        {isArchiveMode(mode) && client && !archive ? (
          <FilePicker
            client={client}
            single
            title={PICKER_TITLES[mode]}
            selected={[]}
            onChange={(paths) => changeArchive(paths[0] ?? "")}
          />
        ) : null}
      </div>
    </main>
  );
}
