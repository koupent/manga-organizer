import { FolderOpen, Package, TriangleAlert, Upload } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { parentDirectory } from "../path";
import { resolveDroppedPaths } from "../lib/dropped";
import { cn } from "../lib/utils";
import {
  FileBrowser,
  type BrowseEntry,
  type BrowseLocation,
} from "./FileBrowser";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
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
   * ファイル整理では処理対象が画面の主役なので作業面を全部渡す。
   * 対象が 1 冊だけの画面では一覧そのものが無く、伸ばす意味も無い。
   */
  fill?: boolean;
  /** 件数の隣に出す操作の案内。何ができる一覧なのかは呼び出し側が決める */
  hint?: string;
  /**
   * 見出しと一覧のあいだに置く行。
   *
   * ファイル整理は主操作をここへ入れる。一覧の直上に置くのは、押したら
   * 何が起きるかを一覧のすぐ上で読めるようにするため（#68・#70）。
   * ファイルを選ぶ側へ入れ替わっても位置が動かないよう、外側に置く。
   */
  actions?: ReactNode;
  /**
   * 一覧の中身。
   *
   * 渡すと、落としたものを平らに並べる既定の一覧の代わりに使う。
   * ファイル整理は解析した 3 階層の一覧をここへ入れる。
   */
  list?: ReactNode;
};

/** 単一選択で選んだ 1 件を出す行。落としたものが何だったかを確かめる用 */
function SelectedItem({ path }: { path: string }) {
  return (
    <li
      data-testid="selected-item"
      data-path={path}
      className="flex items-center gap-2 rounded-control px-2 py-0.5"
    >
      <Package className="size-3.5 shrink-0 text-ink-faint" />
      {/* 名前と場所は一組の情報。名前の幅は中身で決め、余った幅は場所へ渡す。
          名前を伸ばして場所を右端へ飛ばすと、目が行の端から端まで往復する */}
      <span className="min-w-0 truncate text-[12.5px] font-medium">
        {path.split("/").pop()}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[11px] text-ink-faint"
        title={path}
      >
        {parentDirectory(path)}
      </span>
    </li>
  );
}

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
  hint,
  actions,
  list,
}: FilePickerProps) {
  const [browsing, setBrowsing] = useState(false);
  const [location, setLocation] = useState<BrowseLocation>({
    path: "",
    parent: null,
  });
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

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
   * 一覧を書き換える唯一の入り口。
   *
   * 実行中に中身が変わると、実際に処理される内容と画面が食い違う。
   * 経路ごとに止め忘れないよう、ここで一括して弾く。
   */
  const replace = (paths: string[]) => {
    if (locked.current) return;
    // 単一選択でまとめて投入されたら、黙って捨てずに先頭を採る。
    // どれを使ったかは呼び出し側が対象として画面に出す
    onChange(single ? paths.slice(0, 1) : paths);
  };

  const add = (paths: string[]) => {
    replace([...new Set([...selected, ...paths])]);
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

  const defaultList = (
    <ul
      className={cn(
        "divide-y divide-line/60 overflow-y-auto p-1",
        // 溢れた行はこの箱の中でスクロールする。利用者が一覧として
        // 見ている面と、実際にスクロールする面を一致させる
        fill ? "min-h-0 flex-1" : "max-h-64",
      )}
      data-testid="selected-list"
    >
      {selected.map((path) => (
        <SelectedItem key={path} path={path} />
      ))}
    </ul>
  );

  const dropzone = (
    <div
      className={cn(
        "flex flex-col rounded-card border transition-colors",
        // 点線は「まだ何も入っていない」の合図。中身が入った後も囲い続けると、
        // 置いた物を包む箱がもう 1 枚増えるだけで、何も伝えていない
        selected.length === 0 && "border-dashed",
        dragging
          ? "border-brand bg-brand/8"
          : selected.length === 0
            ? "border-line-strong bg-surface/50"
            : "border-line bg-surface/50",
        fill && "min-h-0 flex-1",
      )}
      data-testid="dropzone"
      onDragOver={(event) => {
        event.preventDefault();
        // 受け取れないときに受け取れそうな見た目にしない
        setDragging(!disabled);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void handleDrop(event.dataTransfer);
      }}
    >
      {selected.length === 0 ? (
        <Empty
          className="m-auto"
          icon={<Upload />}
          title="ここにフォルダかアーカイブをドラッグ&ドロップ"
        >
          または「ファイルを選ぶ」から辿ってください。フォルダは下の階層まで
          辿り、ZIP は中を読んで、画像のある所を 1 冊として並べます。zip / cbz /
          rar / 7z を扱えます。
          {single ? "まとめて落としたときは先頭の 1 件を対象にします。" : null}
        </Empty>
      ) : (
        (list ?? defaultList)
      )}
    </div>
  );

  const browser = (
    <FileBrowser
      location={location}
      entries={entries}
      selected={selected}
      single={single}
      disabled={disabled}
      fill={fill}
      onOpen={load}
      onAdd={add}
    />
  );

  return (
    <section className={cn("flex flex-col gap-2", fill && "min-h-0 flex-1")}>
      <div className="flex items-center gap-2">
        <SectionTitle>
          {title ?? (single ? "並べ替えるアーカイブ" : "処理対象ファイル")}
        </SectionTitle>
        {/* 単一選択は一覧を持たない。件数も一括操作も指すものが無い */}
        {single ? null : (
          <>
            <span
              className="tabular text-[12px] text-ink-faint"
              data-testid="selected-count"
            >
              {selected.length} 件
            </span>
            {hint && selected.length > 0 ? (
              <span className="text-[11.5px] text-ink-faint">{hint}</span>
            ) : null}
          </>
        )}
        <div className="flex-1" />
        <Button
          variant={browsing ? "primary" : "secondary"}
          data-testid="open-browser"
          disabled={disabled}
          onClick={() => setBrowsing((open) => !open)}
        >
          <FolderOpen />
          {browsing ? "選択を閉じる" : "ファイルを選ぶ"}
        </Button>
        {single ? null : (
          <Button
            variant="ghost"
            data-testid="clear-selection"
            disabled={disabled || selected.length === 0}
            onClick={() => replace([])}
          >
            一覧を空にする
          </Button>
        )}
      </div>

      {/* 主操作は一覧とファイルブラウザの入れ替わりの外に置く。
          ファイルを選んでいる間も同じ場所にあり、押しに行ける */}
      {actions}

      {/* 一覧とファイルブラウザは同じ作業面を奪い合う。両方を積むと
          どちらも半分の高さになるので、開いている方だけをここに置く */}
      {browsing ? browser : dropzone}

      {error ? (
        <Alert tone="danger" data-testid="picker-error">
          <TriangleAlert />
          <span>{error}</span>
        </Alert>
      ) : null}
    </section>
  );
}
