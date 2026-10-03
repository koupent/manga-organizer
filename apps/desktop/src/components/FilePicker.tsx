import { FolderOpen, FolderPlus, TriangleAlert, Upload } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { resolveDroppedPaths } from "../lib/dropped";
import { cn } from "../lib/utils";
import {
  FileBrowserDialog,
  type BrowseEntry,
  type BrowseLocation,
} from "./FileBrowserDialog";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Dialog, DialogTrigger } from "./ui/dialog";
import { Empty } from "./ui/empty";
import { SectionTitle } from "./ui/section-title";
import type { SidecarClient } from "../api/client";

type FilePickerProps = {
  client: SidecarClient;
  selected: string[];
  onChange: (paths: string[]) => void;
  disabled?: boolean;
  /** 単一選択。ページ並べ替えとサムネイル作成は 1 冊ずつしか扱えない */
  single?: boolean;
  /** 見出し。何のために選ぶのかは呼び出し側の機能でしか分からない */
  title?: string;
  /**
   * 与えられた高さいっぱいまで一覧を伸ばす。
   *
   * ファイル整理では左の列の真ん中が投入の箱で、窓の高さに追従して伸び縮み
   * する。対象が 1 冊だけの画面では一覧そのものが無く、伸ばす意味も無い。
   */
  fill?: boolean;
  /**
   * 投入したものの一覧。何を出すかは呼び出し側の機能が決める。
   *
   * ファイル整理は左の列に、入れたものごと外す × 付きの行を並べる。
   * 単一選択の画面は一覧を持たない。渡さなければ「まだ何も無い」の箱になる。
   */
  list?: ReactNode;
  /**
   * ドラッグ中かどうかを呼び出し側が決める。
   *
   * ファイル整理は窓のどこに落としても受ける（Tauri のドロップは窓に届き、
   * 360px の箱を狙わせる理由が無い）。そのときは受け取りも呼び出し側が
   * 窓で行い、ここは見た目だけを出す。渡さなければ箱そのものが受ける。
   */
  dragging?: boolean;
};

/**
 * 処理対象の選択。
 *
 * 元の Tkinter 版と同じく、まとめて放り込んで一覧で確認する形にする。
 * ブラウザはドロップされたファイルの実パスを取得できないため、
 * サーバー側を辿って選ぶ経路も用意する。Tauri ではネイティブのドロップが
 * 実パスを届けるので、そちらも同じ一覧へ入る。
 *
 * single のときは 1 件だけを選ぶ（ページ並べ替え）。投入の経路が画面ごとに
 * 分かれると、実パスの引き当てのような壊れやすい所を二重に抱えるため、
 * 一覧を持つかどうかだけを変えて同じ入り口を使う。
 *
 * 並べ替えのグリップは外した。フォルダを丸ごと放り込む形になり、落とした
 * ものの順番に意味が無くなったため（#70）。
 */
export function FilePicker({
  client,
  selected,
  onChange,
  disabled = false,
  single = false,
  title,
  fill = false,
  list,
  dragging,
}: FilePickerProps) {
  const [browsing, setBrowsing] = useState(false);
  const [location, setLocation] = useState<BrowseLocation>({
    path: "",
    parent: null,
  });
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const external = dragging !== undefined;
  const shownDragging = external ? dragging : dragOver;
  const empty = !list;

  // 通信の結果は実行が始まった後に届くことがある。そのときの状態で判断する
  const locked = useRef(disabled);
  locked.current = disabled;

  // 描画のたびに作り直すと、これを切っ掛けにする効果が毎回走る。
  // client は接続できたときに一度作るきりなので、ここで留めておく
  const load = useCallback(
    (path = "") => {
      client
        .browse(path)
        .then((result) => {
          setLocation({ path: result.path, parent: result.parent ?? null });
          setEntries(result.entries as BrowseEntry[]);
          setError("");
        })
        .catch((reason) => setError(String(reason.message ?? reason)));
    },
    [client],
  );

  // 辿り始めたときに、まだ何も読んでいなければ根から読む。読み込めた後は
  // location.path が埋まるので、この効果が走り直しても何もしない
  useEffect(() => {
    if (browsing && !location.path) load();
  }, [browsing, location.path, load]);

  /**
   * 一覧を書き換える唯一の入り口。書き換えたときだけ true を返す。
   *
   * 実行中に中身が変わると、実際に処理される内容と画面が食い違う。
   * 経路ごとに止め忘れないよう、ここで一括して弾く。
   */
  const replace = (paths: string[]) => {
    if (locked.current) return false;
    // 単一選択でまとめて投入されたら、黙って捨てずに先頭を採る。
    // どれを使ったかは呼び出し側が対象として画面に出す
    onChange(single ? paths.slice(0, 1) : paths);
    return true;
  };

  const add = (paths: string[]) => {
    const applied = replace([...new Set([...selected, ...paths])]);
    // 1 冊だけ選ぶ画面では、選んだ時点で窓は用済み。開いたままだと読み込んだ
    // ページの格子を覆ってしまう。一覧を持つ画面は続けて何件も入れるので、
    // 1 件ごとに閉じると辿り直しになる。閉じるのはここだけの振る舞い
    if (applied && single) setBrowsing(false);
  };

  /** ドロップを受ける。実パスの引き当ては単一選択と共通の経路で行う */
  const handleDrop = async (transfer: DataTransfer) => {
    if (locked.current) return;
    const { paths, error: reason } = await resolveDroppedPaths(
      client,
      transfer,
    );
    if (paths.length > 0) add(paths);
    setError(reason);
  };

  const dropzone = (
    <div
      className={cn(
        "relative flex flex-col rounded-card border transition-colors",
        // 点線は「まだ何も入っていない」の合図。中身が入った後も囲い続けると、
        // 置いた物を包む箱がもう 1 枚増えるだけで、何も伝えていない
        empty && "border-dashed",
        shownDragging
          ? "border-brand bg-brand/8"
          : empty
            ? "border-line-strong bg-surface/50"
            : "border-line bg-surface/50",
        fill && "min-h-[88px] flex-1",
      )}
      data-testid="dropzone"
      data-dragging={String(shownDragging)}
      {...(external
        ? {}
        : {
            onDragOver: (event: DragEvent) => {
              event.preventDefault();
              // 受け取れないときに受け取れそうな見た目にしない
              setDragOver(!disabled);
            },
            onDragLeave: () => setDragOver(false),
            onDrop: (event: DragEvent) => {
              event.preventDefault();
              setDragOver(false);
              void handleDrop(event.dataTransfer);
            },
          })}
    >
      {empty ? (
        <Empty
          className="m-auto"
          icon={<Upload />}
          title={
            shownDragging
              ? "離すと追加します"
              : "ここにフォルダかアーカイブをドラッグ&ドロップ"
          }
        >
          {shownDragging
            ? "フォルダとアーカイブをまとめて落とせます"
            : single
              ? "または「ファイルを選ぶ」から辿ってください。フォルダは下の階層まで辿り、ZIP は中を読んで、画像のある所を 1 冊として並べます。zip / cbz / rar / 7z を扱えます。まとめて落としたときは先頭の 1 件を対象にします。"
              : "または上の「選んで追加」から辿ります。フォルダは下の階層まで、ZIP は中まで読んで、画像のある所を 1 冊として右に並べます。zip / cbz / rar / 7z"}
        </Empty>
      ) : (
        list
      )}
      {/* 中身がある箱では、行の上に幕を重ねて「離すと追加します」と言う。
          行を消さないので、何が入っているかは透けて見えたまま */}
      {!empty && shownDragging ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 rounded-card bg-canvas/80 text-center">
          <Upload className="size-7 text-brand" />
          <p className="text-[13px] font-medium text-brand">離すと追加します</p>
          <p className="text-[12px] text-ink-faint">
            フォルダとアーカイブをまとめて落とせます
          </p>
        </div>
      ) : null}
    </div>
  );

  const sectionTitle =
    title ?? (single ? "並べ替えるアーカイブ" : "投入したもの");

  return (
    /*
      辿る一覧は重ねた窓で出す。開閉のボタンは窓の外の見出し行に残るので、
      Radix に「この窓を開いた当人」として扱わせるため DialogTrigger にする。
      そうしないと、開いている間にボタンを押したとき、窓の外を押した扱いで
      一度閉じてから、ボタン自身の切り替えで開き直してしまう。

      重ねるが後ろは塞がない（modal なし）。塞ぐと、見えている処理対象の一覧に
      触れなくなるうえ、開閉のボタン自体も覆いの下へ入って押せなくなる。
    */
    <Dialog modal={false} open={browsing} onOpenChange={setBrowsing}>
      <section className={cn("flex flex-col gap-2", fill && "min-h-0 flex-1")}>
        <div className="flex h-7 shrink-0 items-center gap-2">
          <SectionTitle>{sectionTitle}</SectionTitle>
          {/* 単一選択は一覧を持たない。件数も一括操作も指すものが無い */}
          {single ? null : (
            <span
              className="tabular text-[12px] text-ink-faint"
              data-testid="selected-count"
            >
              {selected.length} 件
            </span>
          )}
          <div className="flex-1" />
          <DialogTrigger asChild>
            <Button
              variant={browsing ? "primary" : "secondary"}
              data-testid="open-browser"
              disabled={disabled}
            >
              {single ? <FolderOpen /> : <FolderPlus />}
              {/* 一覧を持つ画面は開いていても名前を変えない。開いていることは
                  色で分かり、もう一度押せば閉じる */}
              {single
                ? browsing
                  ? "選択を閉じる"
                  : "ファイルを選ぶ"
                : "選んで追加"}
            </Button>
          </DialogTrigger>
          {single ? null : (
            <Button
              variant="ghost"
              data-testid="clear-selection"
              disabled={disabled || empty}
              onClick={() => replace([])}
            >
              空にする
            </Button>
          )}
        </div>

        {/* 落とす場所と投入した一覧は、辿っている間も居場所を明け渡さない。
            入れたものを見ながら次を選べるようにするのが窓へ移した理由 */}
        {dropzone}

        {error ? (
          <Alert tone="danger" data-testid="picker-error">
            <TriangleAlert />
            <span>{error}</span>
          </Alert>
        ) : null}
      </section>

      <FileBrowserDialog
        location={location}
        entries={entries}
        selected={selected}
        single={single}
        disabled={disabled}
        title={single ? `${sectionTitle}を選ぶ` : "投入するものを選ぶ"}
        description={
          single
            ? "フォルダを辿って、対象にするアーカイブを 1 つ選びます。選ぶとこの窓は閉じます。"
            : "フォルダやアーカイブを辿って、処理対象の一覧へ足します。足してもこの窓は開いたままです。"
        }
        onOpen={load}
        onAdd={add}
      />
    </Dialog>
  );
}
