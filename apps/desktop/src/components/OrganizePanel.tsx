import { BookMarked, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  sidecarReason,
  type LibraryImportResult,
  type SidecarClient,
} from "../api/client";
import {
  nameHint,
  ORGANIZED_STATUS_TIP,
  organizeSummary,
  planSummary,
} from "../lib/organize-text";
import {
  buildPlanRows,
  droppedBookCount,
  effectiveOff,
  keptBooks,
  keptIssueCounts,
  keptLeafRows,
  namelessKeptRows,
  needsSeriesName,
  organizedSkippedCount,
  outputNames,
  selectedBooks,
  toggleLeaves,
  toggleTargets,
  type Decisions,
  type PlanRow,
  type PlannedBook,
} from "../lib/plan";
import { cn } from "../lib/utils";
import { DirectoryPicker } from "./DirectoryPicker";
import { FailedList, type OrganizeFailure } from "./FailedList";
import { FilePicker } from "./FilePicker";
import { LibraryEditor } from "./LibraryEditor";
import { OrganizeLog } from "./OrganizeLog";
import { PlanActions } from "./PlanActions";
import { PlanList } from "./PlanList";
import { ProducedList, type HandoffMode } from "./ProducedList";
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
import { SectionTitle } from "./ui/section-title";

type Entry = { title: string; author: string };

/** 対を突き合わせるための鍵。作品名と著者の両方が同じものを 1 つと見る */
function pairKey(entry: Entry): string {
  return JSON.stringify([entry.title, entry.author]);
}

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

/**
 * ジョブの結果から、出来たファイルと失敗を取り出す。
 *
 * 走り切ったジョブは結果を持たないこともある。受け取る側が毎回
 * 空の場合を気にしなくて済むよう、ここで形を揃える。
 */
function organizeResult(result: unknown): {
  produced: string[];
  failed: OrganizeFailure[];
} {
  const value = result as {
    produced?: string[];
    failed?: OrganizeFailure[];
  } | null;
  return { produced: value?.produced ?? [], failed: value?.failed ?? [] };
}

/**
 * 解析ジョブから読み取った、いまの解析の様子。
 *
 * 走っているかどうかまで同じジョブから決めるのは、行の中身と「解析中」の
 * 表示がずれないようにするため。別々に持つと、本が出そろっているのに主操作が
 * 押せない（あるいはその逆）という食い違いが起こる。
 */
type Analysis = {
  running: boolean;
  /** 走査で見つかった入れ物。処理する順 */
  containers: string[];
  /** 目次を読めた入れ物から出来る本 */
  books: PlannedBook[];
  /** 目次を読めなかった入れ物 */
  unreadable: string[];
};

const IDLE_ANALYSIS: Analysis = {
  running: false,
  containers: [],
  books: [],
  unreadable: [],
};

/**
 * 解析ジョブの結果から、一覧に要るものを取り出す。
 *
 * 走り始めた直後の結果は空なので、受け取る側が毎回それを気にしなくて済むよう
 * ここで形を揃える。
 */
function analysisResult(result: unknown): Omit<Analysis, "running"> {
  const value = result as {
    containers?: string[];
    books?: PlannedBook[];
    unreadable?: { source: string; reason: string }[];
  } | null;
  return {
    containers: value?.containers ?? [],
    books: value?.books ?? [],
    unreadable: (value?.unreadable ?? []).map((item) => item.source),
  };
}

/**
 * 応答が前と同じかを見分ける印。
 *
 * 解析の途中経過は入れ物 1 つを読むごとにしか書かれないので、その合間の
 * 応答は前と同じものになる。中身を突き合わせると、1 万冊の一覧を毎回
 * 比べることになるため、動く所だけを見る。
 */
function snapshotMark(job: {
  updated_at: string;
  state: string;
  current: number;
  total: number;
}): string {
  return [job.updated_at, job.state, job.current, job.total].join("/");
}

type OrganizePanelProps = {
  client: SidecarClient;
  /** いま見えている画面かどうか。隠れている間はジョブの監視を止める */
  active?: boolean;
  sources: string[];
  onSourcesChange: (paths: string[]) => void;
  outputDirectory: string;
  onOutputDirectoryChange: (path: string) => void;
  /** 出来たファイルを、指定した画面へ読み込んだ状態で開く */
  onOpenProduced: (path: string, mode: HandoffMode) => void;
};

/**
 * ファイル整理。
 *
 * 作品名と著者を先に決め、処理対象のアーカイブを並べ、まとめて整理する。
 * 1 回の実行で扱う作品はひとつ。元の Tkinter 版と同じ流れにしてある。
 */
export function OrganizePanel({
  client,
  active = true,
  sources,
  onSourcesChange,
  outputDirectory,
  onOutputDirectoryChange,
  onOpenProduced,
}: OrganizePanelProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  // 辞書から返事をもらった作品名。もう一度は勧めない。断られた対は辞書に
  // 入らないままなので、これが無いと「押しても何も起きない操作」が画面に
  // 残り続ける
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [authorSource, setAuthorSource] = useState<AuthorSource>("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);

  const [keepOriginals, setKeepOriginals] = useState(true);
  const [running, setRunning] = useState(false);
  // 実行に絡む状態の文言。実行していない間は空にして、一覧の集計に場所を譲る
  const [status, setStatus] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  // 解析で分かったこと。走査が終わるまでは入れ物も空
  const [analysis, setAnalysis] = useState<Analysis>(IDLE_ANALYSIS);

  // 利用者がチェックを触った行だけの台帳。既定（整理済みの本はオフ）は覚えず、
  // 行から毎回導き直す。画面が推し量った値まで覚えると、解析で行が組み直される
  // たびに書き潰され、利用者の選択が消える
  const [decisions, setDecisions] = useState<Decisions>(new Map());

  // 整理して出来たファイルの絶対パス。実際に出来たものだけを持つので、
  // 中断・失敗のときは空のままになる
  const [produced, setProduced] = useState<string[]>([]);

  // 整理できなかったアーカイブと、その理由。ジョブは失敗しても succeeded で
  // 終わるため、ここに出さないと処理ログを開くまで失敗に気づけない
  const [failures, setFailures] = useState<OrganizeFailure[]>([]);

  // 打ち直しの途中で古い検索結果が届いても無視できるようにする
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);

  // 利用者が著者を決めたか。決めた後に遅れて届いた検索結果で上書きしないため
  const authorChosen = useRef(false);

  // ジョブ番号は描画に使わない。中断時に最新の値を確実に読むため ref で持つ
  const jobId = useRef<string | null>(null);

  // 中断はジョブ投入前にも押せる。押された事実を残し、番号が分かった直後に届ける
  const cancelRequested = useRef(false);

  // アンマウント後の state 更新を止める
  const unmounted = useRef<AbortController | null>(null);
  const isGone = () => unmounted.current?.signal.aborted === true;

  // 隠れている間はジョブの監視を止める合図。別の画面を使っている間ずっと
  // 裏で問い合わせが走らないようにする。見えたところで新しく作り直し、
  // 走らせたままのジョブがあれば監視を引き継ぐ
  const paused = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    unmounted.current = controller;
    return () => {
      controller.abort();
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    paused.current = controller;
    // 隠れている間は最初から止まった状態にしておく
    if (!active) controller.abort();
    return () => controller.abort();
  }, [active]);

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

  /**
   * 投入したものを解析し直す。
   *
   * 切っ掛けは投入の中身だけにする。作品名と著者は名前の組み立てにしか
   * 効かず、一覧の名前は巻数から組み立て直すので、打つたびに目次を
   * 読み直す必要は無い。
   */
  useEffect(() => {
    if (sources.length === 0) {
      setAnalysis(IDLE_ANALYSIS);
      return;
    }
    const controller = new AbortController();
    // 投入が変われば前の解析は用済み。番号が分かる前に変わることもあるので、
    // run() / cancel() と同じように「見限った」ことを残しておき、番号を得た
    // 直後に届ける。届けないと、読む必要のなくなった目次をサイドカーが
    // 読み続け、画面が見ている経路まで詰まる
    let analyzeId: string | null = null;
    let abandoned = false;
    const stopAnalysis = () => {
      if (analyzeId) void client.cancelJob(analyzeId).catch(() => undefined);
    };

    // 投入した瞬間から解析中。往復を待つ間に主操作を押せてしまわないよう、
    // ジョブの番号が返るより先に立てる
    setAnalysis({ ...IDLE_ANALYSIS, running: true });
    // 前と同じ応答は、行を組み直さずに見送る
    let seen = "";

    // 投入そのものは中断しない。応答を捨てると、サイドカーが作ったジョブの
    // 番号が分からなくなり、要らなくなった解析を止められなくなる
    client
      .analyze(sources, title, author)
      .then(async (accepted) => {
        analyzeId = accepted.id;
        if (abandoned) {
          stopAnalysis();
          return;
        }
        const job = await client.waitForJob(
          accepted.id,
          (snapshot) => {
            if (snapshotMark(snapshot) === seen) return;
            seen = snapshotMark(snapshot);
            // 経過（log）はここで読まない。整理の実行に取っておく。
            // 解析の行を混ぜると、整理で何が起きたのかがその中に埋もれる
            setAnalysis({
              running:
                snapshot.state === "queued" || snapshot.state === "running",
              ...analysisResult(snapshot.result),
            });
            setProgress({ current: snapshot.current, total: snapshot.total });
          },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setAnalysis({ running: false, ...analysisResult(job.result) });
        }
      })
      .catch(() => {
        // 解析できなくても投入そのものは生きている。行はそのまま残し、
        // 実行時に展開してみて分かる結果に委ねる
        if (!controller.signal.aborted) setAnalysis(IDLE_ANALYSIS);
      });

    return () => {
      abandoned = true;
      controller.abort();
      stopAnalysis();
    };
    // title と author は依存に入れない（上の理由）。この 2 つは組み立てに
    // 使うだけの材料で、読み直す切っ掛けではない。依存に入れると 1 文字
    // 打つたびに目次を読み直しに行く。exhaustive-deps は「読んでいる値は
    // すべて切っ掛け」としか言えないため、ここでは規則の側が合わない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, sources]);

  const rows = useMemo(
    () =>
      buildPlanRows(
        sources,
        analysis.containers,
        analysis.books,
        analysis.unreadable,
      ),
    [sources, analysis],
  );
  const names = useMemo(
    () => outputNames(rows, author, title),
    [rows, author, title],
  );
  // いま外れている葉。触った覚えと既定から毎回導き直すので、解析中に外した
  // 入れ物へ後から本が生えても、その本は外れたまま出る。1 度だけ導いて、
  // 読む所すべてで同じものを使う
  const off = useMemo(() => effectiveOff(rows, decisions), [rows, decisions]);
  const keptCount = keptBooks(rows, off).length;
  const droppedCount = droppedBookCount(rows, off);
  const organizedCount = organizedSkippedCount(rows, off);
  const issues = keptIssueCounts(rows, off);
  // 実際に何かが作られる単位。作る本が 1 つも無いことと、左の列が要るかを
  // どちらもここから決める
  const keptLeafCount = keptLeafRows(rows, off).length;
  const namelessCount = namelessKeptRows(rows, off).length;
  const needsName = needsSeriesName(rows, off);
  // 整理済みの行が 1 つも無いなら、整理済みにまつわる但し書きは出さない。
  // 一度も整理していない利用者に無用の説明を増やさない
  const hasOrganized = rows.some((row) => row.organized);

  /**
   * 整理済みの本が名前に持っている、作品名と著者の対（#73 段階 6）。
   *
   * チェックの状態は見ない。整理済みの行は既定でオフなので、選んだ行から
   * 数えると常に 0 件になり、取り込みの操作が出ることが無くなる。
   *
   * 同じ対で 1 つにまとめる。整理済みの本は 1 冊 1 ファイルなので、5 巻ある
   * 作品は同じ対を 5 回出してくる。冊数で数えると、押す前の件数が利用者の
   * 目に見える作品の数と合わない。
   */
  const shelfPairs = useMemo(() => {
    const found = new Map<string, Entry>();
    for (const row of rows) {
      if (row.kind !== "book" || !row.organized) continue;
      if (!row.title || !row.author) continue;
      const pair = { title: row.title, author: row.author };
      found.set(pairKey(pair), pair);
    }
    return [...found.values()];
  }, [rows]);

  /**
   * まだ辞書に入れられる対。
   *
   * 辞書が既にその対で覚えているものと、この画面で一度返事をもらった作品名を
   * 除く。返事をもらった分まで残すと、辞書が受け付けなかった対（著者が
   * 食い違うもの）を押し続けられる操作として画面に残してしまう。
   *
   * ここで辞書を引き直して整理済みかどうかを決め直すことはしない。流れるのは
   * 判定 → 辞書の一方向だけ。逆に辞書を判定へ流すと、PC ごとに違う可変の状態で
   * 同じ蔵書の判定が変わる。
   */
  const importable = useMemo(() => {
    const known = new Set(entries.map(pairKey));
    return shelfPairs.filter(
      (pair) => !known.has(pairKey(pair)) && !answered.has(pair.title),
    );
  }, [shelfPairs, entries, answered]);

  /**
   * 取り込みの返事を受け取る。
   *
   * 返事のあった作品名を控えてから辞書を読み直す。控えないと、著者が食い違って
   * 入らなかった対が「まだ辞書に無い対」として数え直され、何度でも勧めることに
   * なる。
   */
  const rememberImported = (result: LibraryImportResult) => {
    setAnswered((current) => {
      const next = new Set(current);
      for (const item of result.imported) next.add(item.title);
      for (const item of result.unchanged) next.add(item.title);
      for (const item of result.conflicts) next.add(item.title);
      return next;
    });
    loadEntries();
  };

  /**
   * 実行に足りていないもの。
   *
   * 揃うまで主操作は押せない。押せないだけでは何が足りないのか分からないので、
   * 同じ内容を主操作の行に文字でも出す。
   *
   * 順番が要る。作る本が 1 冊も無いことは、左の列より先に立つ。逆にすると、
   * 全部整理済みの蔵書で何もチェックしていない利用者に「作品名を入れて
   * ください」と言うことになり、その作品名はどこにも使われない。
   */
  const problems = useMemo(() => {
    if (sources.length === 0) return ["処理対象のファイルを追加してください"];
    if (!outputDirectory.trim()) return ["出力先を選んでください"];
    // 作る本が無いことは、状態の行に出す 1 行がそのまま理由になる
    if (keptLeafCount === 0)
      return [planSummary(keptCount, droppedCount, organizedCount)];
    if (!needsName) return [];
    const found: string[] = [];
    if (!title.trim()) found.push("作品名を入れてください");
    if (!author.trim()) found.push("著者を入れてください");
    return found;
  }, [
    sources,
    outputDirectory,
    keptLeafCount,
    needsName,
    keptCount,
    droppedCount,
    organizedCount,
    title,
    author,
  ]);

  /** チェックを付け外しする。親を触ったら下の葉をまとめて動かす */
  const toggleRow = (row: PlanRow, keep: boolean) => {
    setDecisions((current) => toggleLeaves(current, toggleTargets(row), keep));
  };

  /** 一覧ごとまとめて付け外しする。主操作の行の全体チェックが使う */
  const toggleAll = (keep: boolean) => {
    setDecisions((current) =>
      toggleLeaves(current, rows.flatMap(toggleTargets), keep),
    );
  };

  /** 落としたものを一覧から外す。実行中は中身を変えさせない */
  const removeSource = (path: string) => {
    if (running) return;
    onSourcesChange(sources.filter((item) => item !== path));
  };

  /**
   * 投入済みのジョブを終わりまで見届け、結果を画面に出す。
   *
   * 画面から隠れると監視は止まる。そのときはジョブ番号も実行中の印も
   * 残したままにして、戻ってきたところで同じジョブを引き継ぐ。ジョブ自体は
   * サイドカー側で走り続けているので、見に行き直せば結果を拾える。
   */
  const watchJob = async (id: string) => {
    // 見に行き始めた時点の合図を掴んでおく。隠れた後に新しい合図へ
    // 差し替わっても、この監視を終わらせるかどうかは掴んだ方で決める
    const signal = paused.current?.signal;
    const stopped = () => isGone() || signal?.aborted === true;

    try {
      const job = await client.waitForJob(
        id,
        (snapshot) => {
          // 総数はサイドカーが投入時に決める。フォルダは中身へ展開され、
          // 外した本のぶんも引かれるので、画面の件数で補うと食い違う（#65）
          setProgress({ current: snapshot.current, total: snapshot.total });
          setLog(snapshot.log ?? []);
        },
        { signal },
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
      // 状態の produced / failures を隠さないよう別名にする。ここで扱うのは
      // 「今回の実行で返ってきたもの」で、画面に出ている一覧とは別物
      const outcome = organizeResult(job.result);
      setProduced(outcome.produced);
      setFailures(outcome.failed);
      setStatus(
        organizeSummary(outcome.produced.length, outcome.failed.length),
      );
      loadEntries();
    } catch (error) {
      // 画面が消えた・隠れたことによる打ち切りは、利用者に見せる失敗ではない
      if (stopped()) return;
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      // 隠れて止まっただけなら、まだ終わっていない。番号も印も残す
      if (!stopped()) {
        jobId.current = null;
        setRunning(false);
      }
    }
  };

  // 隠れている間に止めた監視を、戻ってきたところで引き継ぐ。
  // 切っ掛けは active だけにする。watchJob は描画のたびに作り直されるので、
  // 依存に入れると往復と関係なく二重に見に行く。useCallback で留めるには
  // watchJob が呼ぶ loadEntries から先まで留め直すことになり、この画面の
  // 状態の持ち方ごと変える話になるので、ここでは規則を外す
  useEffect(() => {
    if (active && jobId.current) void watchJob(jobId.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const run = async () => {
    // 主操作は足りないものがある間は押せない。ここで弾くのは、押せない
    // はずの経路（Enter など）から入ってきたときの受け皿
    if (blocked) return;

    setRunning(true);
    cancelRequested.current = false;
    jobId.current = null;
    setLog([]);
    // 前回の結果はここで捨てる。今回が中断・失敗に終わったとき、前回の
    // 一覧が残っていると「今回出来たもの」に見えてしまう
    setProduced([]);
    setFailures([]);
    setStatus("整理しています...");
    // 総数はサイドカーが投入時に決める。ここで見込みを入れると、外した本の
    // ぶんだけ多い数が一瞬見えてしまう
    setProgress({ current: 0, total: 0 });

    try {
      // 次回以降の候補に出せるよう、実行時の組み合わせを辞書へ残す。
      // 片方でも空なら送らない。サイドカーは空の作品名を 400 で断り、その
      // 失敗はここで握りつぶされるので、誰にも見えない往復が 1 つ増えるだけ
      if (title.trim() && author.trim()) {
        await client.saveEntry(title, author).catch(() => undefined);
      }

      // ここまでに中断が押されていれば、そもそもジョブを投入しない
      if (cancelRequested.current) {
        setStatus("中断しました");
        setRunning(false);
        return;
      }

      const accepted = await client.organize({
        archives: sources,
        output_directory: outputDirectory,
        title,
        author,
        keep_originals: keepOriginals,
        // 一覧で残した本だけを作る。空の配列は「1 冊も作らない」であって
        // 「指定なし」ではないので、省かずに必ず載せる
        books: selectedBooks(rows, off),
      });
      jobId.current = accepted.id;

      // 投入を待つ間に押された中断を、番号が分かったこの時点で届ける
      if (cancelRequested.current) {
        await client.cancelJob(accepted.id).catch(() => undefined);
      }

      await watchJob(accepted.id);
    } catch (error) {
      // 画面が消えたことによる打ち切りは、利用者に見せる失敗ではない
      if (isGone()) return;
      // 断られた理由だけを出す。投入が断られることは実際にある（出力先を
      // 選び直す前など）ので、そのまま出すと利用者は理由を JSON の殻ごと読む
      setStatus(sidecarReason(error));
      jobId.current = null;
      setRunning(false);
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

  /**
   * 主操作を押せない理由。無ければ空。
   *
   * 解析の途中で押せてしまうと、「この内容で」の内容が揃う前に走り出す。
   * 足りない入力があるときも同じで、押せる見た目のまま何も起きないより、
   * 押せないうえで理由を出す。
   */
  const blockedBy = running
    ? "実行中です"
    : analysis.running
      ? "解析しています..."
      : problems.join(" / ");
  const blocked = blockedBy !== "";

  /**
   * 主操作の行に出す 1 行。
   *
   * 実行に絡む文言があればそれを優先する。無ければ、押したら何が起きるかか、
   * 押せない理由のどちらかを出す。
   */
  const statusText =
    status ||
    (blockedBy
      ? blockedBy
      : planSummary(keptCount, droppedCount, organizedCount));

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
            {/* 整理済みの行があるときだけ、左の列が何に使われるかを添える */}
            {hasOrganized ? (
              <span
                className="min-w-0 truncate text-[11px] text-ink-faint"
                data-testid="organize-name-hint"
              >
                {nameHint(keptLeafCount, namelessCount)}
              </span>
            ) : null}
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
      </aside>

      {/*
        作業面。処理対象の一覧が高さいっぱいを取り、実行の結果だけが
        下に居場所を持つ。失敗と出来たファイルは処理ログの真上に置く。
        どれも「実行して何が起きたか」を見る所で、離すと目が往復する。
      */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <FilePicker
          client={client}
          selected={sources}
          onChange={onSourcesChange}
          disabled={running}
          fill
          hint="チェックを外すと作りません · Delete で落としたものを外す"
          actions={
            <PlanActions
              rows={rows}
              excluded={off}
              status={statusText}
              statusTitle={hasOrganized ? ORGANIZED_STATUS_TIP : undefined}
              issues={issues}
              progress={progress}
              running={running}
              blocked={blocked}
              onToggleAll={toggleAll}
              onRun={run}
              onCancel={cancel}
            />
          }
          list={
            <PlanList
              rows={rows}
              excluded={off}
              names={names}
              outputDirectory={outputDirectory}
              locked={running}
              onToggle={toggleRow}
              onRemove={removeSource}
              // 整理済みの行の近道は、出来たファイルの一覧と同じ受け渡しを
              // 通る。行が渡すのは、いまディスク上に在る元のファイル
              onOpenArchive={onOpenProduced}
            />
          }
        />
        {/*
          失敗は出来たファイルより先に置く。放っておけないのはこちらで、
          出来たぶんの一覧に押し下げられて見落とすと元も子もない。
        */}
        <FailedList failures={failures} />
        <ProducedList paths={produced} onOpen={onOpenProduced} />
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
          <LibraryEditor
            client={client}
            importable={importable}
            onImported={rememberImported}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
