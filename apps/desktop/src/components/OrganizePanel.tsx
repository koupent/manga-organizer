import { BookMarked, Loader2, Play, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SidecarClient } from "../api/client";
import { cn } from "../lib/utils";
import { DirectoryPicker } from "./DirectoryPicker";
import { FilePicker } from "./FilePicker";
import { LibraryEditor } from "./LibraryEditor";
import { OrganizeLog } from "./OrganizeLog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Progress } from "./ui/progress";
import { SectionTitle } from "./ui/section-title";

type Entry = { title: string; author: string };

/** 検索で見つかった作品と著者。近い順に並ぶ */
type Candidate = {
  title: string;
  author: string;
  source: string;
  similarity: number;
};

/** 著者をどこから持ってきたか。元の実装と同じく、辞書由来は色を変えて示す */
type AuthorSource = "" | "library" | "search";

/** 何文字目から自動で著者を探しに行くか。元の実装と同じ */
const MIN_SEARCH_LENGTH = 2;

/** 打つたびに問い合わせないための待ち時間 */
const SEARCH_DELAY_MS = 400;

type OrganizePanelProps = {
  client: SidecarClient;
  sources: string[];
  onSourcesChange: (paths: string[]) => void;
  outputDirectory: string;
  onOutputDirectoryChange: (path: string) => void;
};

/**
 * ファイル整理。
 *
 * 作品名と著者を先に決め、処理対象のアーカイブを並べ、まとめて整理する。
 * 1 回の実行で扱う作品はひとつ。元の Tkinter 版と同じ流れにしてある。
 */
export function OrganizePanel({
  client,
  sources,
  onSourcesChange,
  outputDirectory,
  onOutputDirectoryChange,
}: OrganizePanelProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [authorSource, setAuthorSource] = useState<AuthorSource>("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);

  const [keepOriginals, setKeepOriginals] = useState(true);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("待機中");
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  // 打ち直しの途中で古い検索結果が届いても無視できるようにする
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);

  // 利用者が著者を決めたか。決めた後に遅れて届いた検索結果で上書きしないため
  const authorChosen = useRef(false);

  // ジョブ番号は描画に使わない。中断時に最新の値を確実に読むため ref で持つ
  const jobId = useRef<string | null>(null);

  // 中断はジョブ投入前にも押せる。押された事実を残し、番号が分かった直後に届ける
  const cancelRequested = useRef(false);

  // アンマウント後のポーリングと state 更新を止める
  const unmounted = useRef<AbortController | null>(null);
  const isGone = () => unmounted.current?.signal.aborted === true;

  useEffect(() => {
    const controller = new AbortController();
    unmounted.current = controller;
    return () => {
      controller.abort();
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const loadEntries = useCallback(() => {
    client
      .knownEntries()
      .then((payload) => {
        if (isGone()) return;
        setEntries(payload.entries);
      })
      .catch(() => undefined);
  }, [client]);

  useEffect(loadEntries, [loadEntries]);

  /**
   * 辞書を開け閉めする。
   *
   * 閉じるときに読み直すのは、辞書で足した作品名や著者をそのまま入力欄の
   * 候補として使えるようにするため。
   */
  const changeLibraryOpen = (open: boolean) => {
    setLibraryOpen(open);
    if (!open) loadEntries();
  };

  /**
   * 作品名が変わったら著者を引き直す。
   *
   * 辞書に完全一致があれば即座に埋める。無ければ少し待ってから外部検索する。
   * 古い作品名の著者が残らないよう、まず空にする。
   */
  const changeTitle = (next: string) => {
    setTitle(next);
    setAuthor("");
    setAuthorSource("");
    setCandidates([]);
    setSearching(false);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    authorChosen.current = false;

    const known = entries.find((entry) => entry.title === next);
    if (known?.author) {
      setAuthor(known.author);
      setAuthorSource("library");
      return;
    }
    if (next.trim().length < MIN_SEARCH_LENGTH) return;

    setSearching(true);
    searchTimer.current = setTimeout(() => {
      client
        .suggestAuthor(next)
        .then((found) => {
          if (isGone() || seq !== searchSeq.current) return;
          // 選び直す助けになるので、候補そのものは著者を決めた後でも出す
          setCandidates(found.candidates ?? []);
          // 近い順に並ぶので、先頭をそのまま入れて残りは候補に出す。
          // ただし利用者が先に決めていれば、遅れて届いた答えで覆さない
          if (found.author && !authorChosen.current) {
            setAuthor(found.author);
            setAuthorSource("search");
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (isGone() || seq !== searchSeq.current) return;
          setSearching(false);
        });
    }, SEARCH_DELAY_MS);
  };

  const problems = (): string[] => {
    const found: string[] = [];
    if (!title.trim()) found.push("作品名を入れてください");
    if (!author.trim()) found.push("著者を入れてください");
    if (!outputDirectory.trim()) found.push("出力先を選んでください");
    if (sources.length === 0)
      found.push("処理対象のファイルを追加してください");
    return found;
  };

  const run = async () => {
    const found = problems();
    if (found.length > 0) {
      setStatus(found.join(" / "));
      return;
    }

    setRunning(true);
    cancelRequested.current = false;
    jobId.current = null;
    setLog([]);
    setStatus("整理しています...");
    setProgress({ current: 0, total: sources.length });

    try {
      // 次回以降の候補に出せるよう、実行時の組み合わせを辞書へ残す
      await client.saveEntry(title, author).catch(() => undefined);

      // ここまでに中断が押されていれば、そもそもジョブを投入しない
      if (cancelRequested.current) {
        setStatus("中断しました");
        return;
      }

      const accepted = await client.organize({
        archives: sources,
        output_directory: outputDirectory,
        title,
        author,
        keep_originals: keepOriginals,
      });
      jobId.current = accepted.id;

      // 投入を待つ間に押された中断を、番号が分かったこの時点で届ける
      if (cancelRequested.current) {
        await client.cancelJob(accepted.id).catch(() => undefined);
      }

      const job = await client.waitForJob(
        accepted.id,
        (snapshot) => {
          setProgress({
            current: snapshot.current,
            total: snapshot.total || sources.length,
          });
          setLog(snapshot.log ?? []);
        },
        { signal: unmounted.current?.signal },
      );
      setLog(job.log ?? []);

      if (job.state === "cancelled") {
        // 利用者が止めた場合は失敗として扱わない
        setStatus("中断しました");
        return;
      }
      if (job.state !== "succeeded") {
        throw new Error(job.error ?? "整理に失敗しました");
      }
      const produced =
        (job.result as { produced?: string[] } | null)?.produced ?? [];
      setProgress({ current: sources.length, total: sources.length });
      setStatus(`${produced.length} 冊を整理しました`);
      loadEntries();
    } catch (error) {
      // 画面が消えたことによる打ち切りは、利用者に見せる失敗ではない
      if (isGone()) return;
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      jobId.current = null;
      if (!isGone()) setRunning(false);
    }
  };

  /**
   * 実行を止める。
   *
   * ジョブ番号が分かる前に押されることがあるので、要求を残しておき
   * run() 側が番号を得た直後に届ける。押したのに黙って完走させない。
   */
  const cancel = async () => {
    cancelRequested.current = true;
    setStatus("中断しています...");
    if (jobId.current) {
      await client.cancelJob(jobId.current).catch(() => undefined);
    }
  };

  const percent =
    progress.total > 0 ? (progress.current / progress.total) * 100 : 0;

  return (
    /*
      ワークベンチ型。設定は幅の決まった左の列に置き、残りは全部
      処理対象の一覧へ渡す。設定は一度決めれば見るだけのもので、
      画面の高さを分け合う相手ではない。
    */
    <div className="flex min-h-0 flex-1 gap-3">
      {/* 入力欄の候補。辞書に記録済みの作品と著者を出す */}
      <datalist id="known-titles">
        {entries.map((entry) => (
          <option key={entry.title} value={entry.title} />
        ))}
      </datalist>
      <datalist id="known-authors">
        {[
          ...new Set([
            ...candidates.map((candidate) => candidate.author),
            ...entries.map((entry) => entry.author),
          ]),
        ]
          .filter(Boolean)
          .map((name) => (
            <option key={name} value={name} />
          ))}
      </datalist>

      {/*
        設定の列。幅を 360px に固定するのは、入力欄が窓幅まで伸びても
        読みやすさが上がらないため。中身が溢れたらこの列だけがスクロールし、
        右の作業面は巻き添えにしない。
      */}
      <aside className="flex w-[360px] shrink-0 flex-col gap-4 overflow-y-auto pr-1">
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <SectionTitle>作品情報</SectionTitle>
            <div className="flex-1" />
            <Button
              data-testid="open-library"
              onClick={() => changeLibraryOpen(true)}
            >
              <BookMarked />
              辞書
            </Button>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] font-medium text-ink-muted">
              作品名
            </span>
            <Input
              value={title}
              list="known-titles"
              placeholder="作品名を入れると著者を探します"
              data-testid="organize-title"
              onChange={(event) => changeTitle(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-muted">
              著者
              {searching ? (
                <span
                  className="flex items-center gap-1 text-ink-faint"
                  data-testid="author-searching"
                >
                  <Loader2 className="size-3 animate-spin" />
                  検索中
                </span>
              ) : null}
            </span>
            <Input
              value={author}
              list="known-authors"
              placeholder="著者"
              data-testid="organize-author"
              data-source={authorSource}
              className={authorSource === "library" ? "text-brand" : undefined}
              onChange={(event) => {
                setAuthor(event.target.value);
                setAuthorSource("");
                authorChosen.current = true;
              }}
            />
          </label>

          {candidates.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-1.5"
              data-testid="author-candidates"
            >
              <span className="text-[11.5px] text-ink-faint">検索結果</span>
              {candidates.map((candidate) => (
                <button
                  key={candidate.author}
                  type="button"
                  data-testid="author-candidate"
                  data-author={candidate.author}
                  title={`${candidate.title}（${candidate.source}）`}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11.5px] transition-colors",
                    candidate.author === author
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
                  )}
                  onClick={() => {
                    setAuthor(candidate.author);
                    setAuthorSource("search");
                    authorChosen.current = true;
                  }}
                >
                  {candidate.author}
                  <span className="ml-1 text-ink-faint">{candidate.title}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>オプション</SectionTitle>
          <DirectoryPicker
            client={client}
            value={outputDirectory}
            onChange={onOutputDirectoryChange}
          />
          <label className="flex w-fit cursor-pointer items-center gap-2 text-[12.5px] text-ink-muted">
            <Checkbox
              data-testid="keep-originals"
              checked={keepOriginals}
              onCheckedChange={(checked) => setKeepOriginals(checked === true)}
            />
            元のファイルを残す
          </label>
        </section>

        {/*
          主操作は列の最下部に固定する。設定の量で位置が上下すると、
          押す場所を毎回探すことになる。右で何が起きても動かない。
        */}
        <div className="mt-auto flex flex-col gap-1.5 pt-2">
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="lg"
              className="flex-1"
              data-testid="confirm"
              disabled={running || sources.length === 0}
              onClick={run}
            >
              <Play />
              この内容で整理する
            </Button>
            {running ? (
              <Button variant="danger" data-testid="cancel" onClick={cancel}>
                <Square />
                中断する
              </Button>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <span
              className="text-[12px] text-ink-muted"
              data-testid="organize-status"
              role="status"
            >
              {status}
            </span>
            <div className="flex-1" />
            {progress.total > 0 ? (
              <span className="tabular text-[12px] text-ink-faint">
                {progress.current} / {progress.total}
              </span>
            ) : null}
          </div>

          <Progress data-testid="progress" value={percent} />
        </div>
      </aside>

      {/*
        作業面。処理対象の一覧が高さいっぱいを取り、処理ログだけが
        下に居場所を持つ。
      */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <FilePicker
          client={client}
          selected={sources}
          onChange={onSourcesChange}
          disabled={running}
          fill
        />
        <OrganizeLog lines={log} />
      </div>

      {/*
        辞書は整理の途中で覗きに行くものなので、画面を切り替えず重ねて出す。
        ここに置いておけば入力途中の作品情報や処理対象の一覧が消えない。
      */}
      <Dialog open={libraryOpen} onOpenChange={changeLibraryOpen}>
        <DialogContent data-testid="library-dialog">
          {/* 見出しと説明は LibraryEditor 側にあるので、読み上げ用にだけ置く */}
          <DialogTitle className="sr-only">辞書</DialogTitle>
          <DialogDescription className="sr-only">
            記録済みの作品名と著者を確認し、追加や削除ができます。
          </DialogDescription>
          <div className="flex justify-end">
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="icon"
                data-testid="library-close"
                aria-label="辞書を閉じる"
                title="辞書を閉じる"
              >
                <X />
              </Button>
            </DialogClose>
          </div>
          <LibraryEditor client={client} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
