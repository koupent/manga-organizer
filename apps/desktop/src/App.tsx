import { BookOpen, FolderOpen, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { cn } from "./lib/utils";
import { baseName, parentDirectory } from "./path";
import { SidecarClient } from "./api/client";
import { FilePicker } from "./components/FilePicker";
import { OrganizePanel } from "./components/OrganizePanel";
import { FileEditor } from "./components/FileEditor";
import type { HandoffMode } from "./components/EditShortcuts";
import {
  onFilesDragging,
  onFilesDropped,
  resolveConnection,
} from "./connection";
import { SettingsDialog } from "./components/SettingsDialog";
import { useStoredString, useStoredNumber } from "./lib/setting";
import { findUpdate, UpdateNotice } from "./components/UpdateNotice";
import { Alert } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Segmented } from "./components/ui/segmented";

type Mode = "organize" | "edit";
const FLASH_MS = 600;
const MODES: { id: Mode; label: string; testId: string }[] = [
  { id: "organize", label: "ディレクトリ整理", testId: "mode-organize" },
  { id: "edit", label: "ファイル編集", testId: "mode-edit" },
];
const isArchiveMode = (mode: Mode) => mode === "edit";

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

/** ディレクトリ整理と、1 冊のファイル編集を切り替える */
export function App() {
  const [client, setClient] = useState<SidecarClient | null>(null);
  // 起動したら、まずファイル整理を出す（#180）。1 冊を編集する画面は、整理した
  // 本の行の近道から移って使う。本を名指しして開いたときだけ、その本の
  // ファイル編集を出す
  const [mode, setMode] = useState<Mode>(() => {
    const params = startupParams();
    const requested = params.get("mode");
    if (requested === "organize") return "organize";
    if (["edit", "thumbnail", "split", "reorder"].includes(requested ?? ""))
      return "edit";
    return params.get("archive") ? "edit" : "organize";
  });
  const [archive, setArchive] = useState(
    () => startupParams().get("archive") ?? "",
  );
  const [error, setError] = useState("");
  const [health, setHealth] = useState("");
  // 新しい版の案内。起動時と、設定の「更新を確認」が出す（#136）
  const [update, setUpdate] = useState<Update | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const [editsVersion, setEditsVersion] = useState(0);

  /**
   * 一度でも開いた画面。開いた画面は隠すだけで捨てず、状態を残す。
   *
   * まだ開いていない画面は作らない。作れば、利用者が一度も見ていない画面の
   * 読み込みや監視が裏で走る。
   */
  const [opened, setOpened] = useState<Mode[]>(() => [mode]);

  const [sources, setSources] = useState<string[]>([]);
  // エクスプローラーから窓の上へ持ってきている最中か（Tauri のドラッグ）
  const [nativeDragging, setNativeDragging] = useState(false);
  // もう一度落とされた投入。増えない代わりに少しのあいだ光らせる
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [defaultOutputDirectory, storeDefaultOutputDirectory] = useStoredString(
    "default-output-directory",
  );
  const restoredOutputDirectory = useRef(defaultOutputDirectory);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [minimumImageCount, setMinimumImageCount] = useStoredNumber(
    "minimum-image-count",
    0,
  );
  const [outputDirectory, setOutputDirectory] = useState(
    () => startupParams().get("output") ?? defaultOutputDirectory,
  );

  const changeDefaultOutputDirectory = (path: string) => {
    storeDefaultOutputDirectory(path);
    setOutputDirectory(path);
  };

  // 起動時に保存済みの出力先を復元する。設定での選び直しは DirectoryPicker が伝える。
  useEffect(() => {
    if (client && restoredOutputDirectory.current.trim()) {
      void client
        .chooseOutputRoot(restoredOutputDirectory.current)
        .catch(() => undefined);
    }
  }, [client]);

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
      setOutputDirectory(
        (current) =>
          current || defaultOutputDirectory || parentDirectory(paths[0]),
      );
    }
    setSources(paths);
  };

  /**
   * 投入に足す。ドロップ（Tauri・ブラウザ）と、整理画面の窓のドロップが通る。
   *
   * 既に入っているものは増やさない。増えないことを黙っていると、落とせたのか
   * どうかが分からないので、その行を少しのあいだ光らせる。
   */
  const addSources = (paths: string[]) => {
    const current = sourcesRef.current;
    const repeated = paths.filter((path) => current.includes(path));
    if (repeated.length > 0) {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      setFlashing(new Set(repeated));
      flashTimer.current = setTimeout(() => setFlashing(new Set()), FLASH_MS);
    }
    changeSources([...new Set([...current, ...paths])]);
  };
  // ドロップの購読は起動時の一度きりなので、最新の addSources は ref から呼ぶ
  const addSourcesRef = useRef(addSources);
  addSourcesRef.current = addSources;

  const archiveChanged = () => setEditsVersion((version) => version + 1);

  /** 画面を移る。移った先は初回だけ作り、以後は隠すだけで捨てない */
  const changeMode = (next: Mode) => {
    setMode(next);
    setOpened((current) =>
      current.includes(next) ? current : [...current, next],
    );
  };

  /** 別の本は key の変更で編集状態を作り直す。同じ本へ戻るときは保留を残す。 */
  const changeArchive = (path: string) => {
    setArchive(path);
    setError("");
  };
  // ドロップの購読は起動時の一度きりなので、いまの本と画面を読む最新の
  // changeArchive は ref から呼ぶ
  const changeArchiveRef = useRef(changeArchive);
  changeArchiveRef.current = changeArchive;

  /**
   * 指定したファイルを読み込んだ状態で、その画面へ移る。
   *
   * ファイル整理で出来たファイルから次の作業へ移るための近道。対象と画面を
   * 同時に決めるので、移った先で選び直す必要がない。対象を先に入れてから
   * 画面を切り替えるのではなく一度に済ませるのは、対象の無い状態を経由すると
   * 移った先で一瞬ファイル選択が出てしまうため。
   */
  const openArchiveIn = (path: string, next: HandoffMode) => {
    changeArchive(path);
    changeMode(next);
  };

  // 起動したときに 1 回だけ、新しい版があるか確かめる
  useEffect(() => {
    let cancelled = false;
    findUpdate()
      .then((found) => {
        if (!cancelled && found) setUpdate(found);
      })
      // 確かめられなくても今の版は使い続けられる。オフラインのたびに
      // 失敗を知らせても、利用者にできることが無い
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
    // 別のタブへ勝手に連れて行かれるより、落とした先で受かる方が素直。
    //
    // 中身が読めたときしかここへは来ない。読めないまま changeMode まで
    // 進むと、画面だけ整理へ切り替わって入力が増えない形が残る
    const pending = onFilesDropped((entries) => {
      if (isArchiveMode(modeRef.current)) {
        // どれも 1 冊ずつしか扱えない。フォルダは本として開けないので飛ばし、
        // まとめて落とされたら最初の 1 冊を採る。フォルダしか無ければ何もしない
        const book = entries.find((entry) => !entry.is_dir);
        if (book) changeArchiveRef.current(book.path);
        return;
      }
      // 整理はフォルダごと受ける。フォルダも本もそのまま入力に足す
      changeMode("organize");
      addSourcesRef.current(entries.map((entry) => entry.path));
    }, setError);
    // 窓の上へ持ってきた・離れた。落とせる所を離す前に示すため（#106）
    const dragging = onFilesDragging(setNativeDragging);

    // 購読そのものが立たないこともある（動的 import や listen の失敗）。
    // 放っておくと未処理の rejection になるだけで、利用者からは「落として
    // も何も起きない」画面に見える。理由を出したうえで、後片付けが必ず
    // 成り立つよう、解除する側は失敗しない約束の方から辿る
    const settled = pending.catch((reason) => {
      if (!cancelled) setError(String(reason.message ?? reason));
      return () => undefined;
    });

    return () => {
      cancelled = true;
      // 解除は購読が立ってから。立つ前に画面が消えても、立った直後に解く
      void settled.then((unlisten) => unlisten());
      void dragging.then(
        (unlisten) => unlisten(),
        () => undefined,
      );
    };
  }, []);

  const archiveName = archive ? baseName(archive) : "";

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

        <nav className="flex items-center gap-2" aria-label="機能">
          <Segmented items={MODES} value={mode} onChange={changeMode} />
        </nav>

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
        <SettingsDialog
          client={client}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          defaultOutputDirectory={defaultOutputDirectory}
          onDefaultOutputDirectoryChange={changeDefaultOutputDirectory}
          minimumImageCount={minimumImageCount}
          onMinimumImageCountChange={setMinimumImageCount}
        />
      </header>

      {/* 中央寄せの上限を置かない。広い窓では左右に余白が積み上がるだけで、
          その間ずっと入力欄や一覧は狭いまま使うことになる。
          溢れたときにスクロールするのはこの中であって、窓ではない */}
      <div className="flex min-h-0 w-full flex-1 flex-col gap-2 overflow-y-auto p-3">
        {update ? (
          <UpdateNotice update={update} onDismiss={() => setUpdate(null)} />
        ) : null}
        {error ? (
          <Alert tone="danger" data-testid="error">
            <TriangleAlert />
            <span>{error}</span>
          </Alert>
        ) : null}

        {/* 編集対象と、別の本を選ぶ操作を常に一覧の上に置く */}
        {isArchiveMode(mode) && archive ? (
          <div
            className="flex h-8 shrink-0 items-center gap-2 rounded-card border border-line bg-surface px-3"
            data-testid="book-bar"
          >
            <BookOpen className="size-3.5 shrink-0 text-ink-faint" />
            <span className="shrink-0 text-[11.5px] text-ink-faint">
              編集中の本
            </span>
            <h2
              className="min-w-0 truncate text-[13px] font-semibold"
              data-testid="archive-name"
              title={archive}
            >
              {archiveName}
            </h2>
            <Button
              variant="ghost"
              className="shrink-0"
              data-testid="change-archive"
              onClick={() => changeArchive("")}
            >
              <FolderOpen />
              別のファイルを選ぶ
            </Button>
          </div>
        ) : null}

        {/* 一度開いた画面は、別の画面へ移っても作り直さない。作品名も
            並べ替えの途中経過も切り抜き枠も、戻ってくればそのまま続けられる */}
        {opened.includes("organize") && client ? (
          <Panel active={mode === "organize"}>
            <OrganizePanel
              active={mode === "organize"}
              client={client}
              sources={sources}
              minimumImageCount={minimumImageCount}
              onSourcesChange={changeSources}
              outputDirectory={outputDirectory}
              onOpenSettings={() => setSettingsOpen(true)}
              onOutputDirectoryChange={setOutputDirectory}
              onOpenProduced={openArchiveIn}
              editsVersion={editsVersion}
              onEditsReset={(path) => {
                archiveChanged();
                if (path === archive) setResetVersion((value) => value + 1);
              }}
              onAddSources={addSources}
              nativeDragging={nativeDragging}
              flashing={flashing}
            />
          </Panel>
        ) : null}

        {opened.includes("edit") && client && archive ? (
          <Panel active={mode === "edit"}>
            <FileEditor
              key={`${archive}:${resetVersion}`}
              client={client}
              archive={archive}
              active={mode === "edit"}
              onArchiveChanged={archiveChanged}
            />
          </Panel>
        ) : null}

        {/* 1 冊を読み込んで使う 3 つの画面は、同じ入り口から投入する。
            実パスの引き当てのような壊れやすい所を三重に抱えない */}
        {isArchiveMode(mode) && client && !archive ? (
          <FilePicker
            client={client}
            single
            title="編集するファイル"
            selected={[]}
            onChange={(paths) => changeArchive(paths[0] ?? "")}
          />
        ) : null}
      </div>
    </main>
  );
}
