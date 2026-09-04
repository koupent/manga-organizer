import { BookOpen, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "./lib/utils";
import { parentDirectory } from "./path";
import { SidecarClient } from "./api/client";
import { CoverEditor } from "./components/CoverEditor";
import { FilePicker } from "./components/FilePicker";
import { PageGrid } from "./components/PageGrid";
import { OrganizePanel } from "./components/OrganizePanel";
import { onFilesDropped, resolveConnection } from "./connection";
import { Alert } from "./components/ui/alert";
import { Segmented } from "./components/ui/segmented";

type Page = { name: string; size: number; modified: string };
type Mode = "organize" | "reorder" | "thumbnail";

// 対象物ではなく、そこで何ができるかでタブを名付ける
const MODES: { id: Mode; label: string }[] = [
  { id: "organize", label: "ファイル整理" },
  { id: "reorder", label: "ページ並べ替え" },
  { id: "thumbnail", label: "サムネイル作成" },
];

const isMode = (value: string | null): value is Mode =>
  MODES.some((item) => item.id === value);

/** ファイル整理・ページ並べ替え・サムネイル作成を切り替えて使う */
export function App() {
  const [client, setClient] = useState<SidecarClient | null>(null);
  const [mode, setMode] = useState<Mode>("reorder");
  const [archive, setArchive] = useState("");
  const [pages, setPages] = useState<Page[]>([]);
  const [cardWidth, setCardWidth] = useState(220);
  const [error, setError] = useState("");
  const [health, setHealth] = useState("");

  const [sources, setSources] = useState<string[]>([]);
  const [outputDirectory, setOutputDirectory] = useState("");

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
   * ページ並べ替え・サムネイル作成の対象を差し替える。
   *
   * 前の対象のページを残したまま次を読み込むと、並べ替え途中の順序が
   * 別のファイルへ持ち越される。空にしてから読み直し、編集ごと捨てる。
   */
  const changeArchive = (path: string) => {
    setPages([]);
    setArchive(path);
    setError("");
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

    const params = new URLSearchParams(window.location.search);
    setArchive(params.get("archive") ?? "");
    setOutputDirectory(params.get("output") ?? "");
    const requested = params.get("mode");
    if (isMode(requested)) setMode(requested);

    // ネイティブ側で受けたドロップは、いま見ている画面の入力にする。
    // 別のタブへ勝手に連れて行かれるより、落とした先で受かる方が素直
    const pending = onFilesDropped((paths) => {
      if (modeRef.current === "reorder" || modeRef.current === "thumbnail") {
        // どちらも 1 冊ずつしか扱えない。まとめて落とされたら先頭を採る
        if (paths.length > 0) changeArchive(paths[0]);
        return;
      }
      setMode("organize");
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
  }, [client, archive, mode]);

  const archiveName = archive ? (archive.split("/").pop() ?? archive) : "";

  return (
    <main>
      {/* 高さを 40px に固定する。中身の寸法に任せると、部品を 1 つ足すたびに
          ヘッダーが伸びて作業面が削れる。作業面の取り分を先に決めておく */}
      <header className="sticky top-0 z-20 flex h-10 items-center gap-4 border-b border-line bg-surface/95 px-4 backdrop-blur">
        <div className="flex items-center gap-2">
          <BookOpen className="size-4 text-brand" />
          <h1 className="text-[13.5px] font-semibold tracking-tight">
            Manga Organizer
          </h1>
        </div>

        <Segmented
          items={MODES.map((m) => ({ ...m, testId: `mode-${m.id}` }))}
          value={mode}
          onChange={setMode}
        />

        <div className="flex-1" />

        {mode === "reorder" ? (
          <label className="flex items-center gap-2 text-[12px] text-ink-muted">
            表示サイズ
            <input
              type="range"
              min={140}
              max={520}
              step={20}
              value={cardWidth}
              data-testid="card-width"
              onChange={(event) => setCardWidth(Number(event.target.value))}
              className="h-1 w-28 cursor-pointer accent-brand"
            />
          </label>
        ) : null}

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
          その間ずっと入力欄や一覧は狭いまま使うことになる */}
      <div className="flex w-full flex-1 flex-col gap-2 p-3">
        {error ? (
          <Alert tone="danger" data-testid="error">
            <TriangleAlert />
            <span>{error}</span>
          </Alert>
        ) : null}

        {mode === "organize" && client ? (
          <OrganizePanel
            client={client}
            sources={sources}
            onSourcesChange={changeSources}
            outputDirectory={outputDirectory}
            onOutputDirectoryChange={setOutputDirectory}
          />
        ) : null}

        {mode === "thumbnail" && client && archive ? (
          <CoverEditor
            // 対象が変われば別の表紙。選んだ 1 枚も切り抜き枠も作り直す
            key={archive}
            client={client}
            archive={archive}
            archiveName={archiveName}
            onChangeArchive={() => changeArchive("")}
          />
        ) : null}

        {mode === "reorder" && client && archive && pages.length > 0 ? (
          <PageGrid
            // 対象が変われば別の本。並べ替えの途中経過ごと作り直す
            key={archive}
            client={client}
            archive={archive}
            archiveName={archiveName}
            pages={pages}
            cardWidth={cardWidth}
            onChangeArchive={() => changeArchive("")}
          />
        ) : null}

        {/* 並べ替えとサムネイル作成は同じ 1 冊を投入する。入り口も同じものを使い、
            実パスの引き当てのような壊れやすい所を二重に抱えない */}
        {(mode === "reorder" || mode === "thumbnail") && client && !archive ? (
          <FilePicker
            client={client}
            single
            title={
              mode === "reorder"
                ? "並べ替えるアーカイブ"
                : "サムネイルを作るアーカイブ"
            }
            selected={[]}
            onChange={(paths) => changeArchive(paths[0] ?? "")}
          />
        ) : null}
      </div>
    </main>
  );
}
