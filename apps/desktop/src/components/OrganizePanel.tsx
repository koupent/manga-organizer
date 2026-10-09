import { EditRestoreDialog } from "./EditRestoreDialog";
import { BookMarked, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  sidecarReason,
  type LibraryImportResult,
  type SidecarClient,
} from "../api/client";
import { useAuthorLookup, type Entry } from "../hooks/useAuthorLookup";
import {
  analysisResult,
  IDLE_ANALYSIS,
  organizeResult,
  refusedPaths,
  snapshotMark,
  withoutPaths,
  type Analysis,
  type FinishedBook,
} from "../lib/analysis";
import { resolveDroppedPaths } from "../lib/dropped";
import {
  ORGANIZED_STATUS_TIP,
  organizeSummary,
  planSummary,
} from "../lib/organize-text";
import {
  bookId,
  buildPlanRows,
  collidingBooks,
  compaction,
  droppedBookCount,
  effectiveOff,
  isInside,
  keptBooks,
  keptIssueCounts,
  keepPicked,
  keptLeafRows,
  namelessKeptRows,
  needsSeriesName,
  organizedSkippedCount,
  oneEachState,
  mostImagesState,
  selectMostImages,
  outputNames,
  reuseRows,
  sameVolumeCounts,
  selectedBooks,
  setOneEach,
  toggleLeaves,
  toggleTargets,
  withOutputBooks,
  type Decisions,
  type OutputBook,
  type PlanRow,
  VOLUME_DUPLICATE,
} from "../lib/plan";
import { cn } from "../lib/utils";
import {
  applyVolumes,
  numberFollowing,
  type VolumeCorrections,
} from "../lib/volumes";
import { FailedList, type OrganizeFailure } from "./FailedList";
import { FilePicker } from "./FilePicker";
import { LibraryEditor } from "./LibraryEditor";
import { OptionsSection } from "./organize/OptionsSection";
import { SeriesInfoSection } from "./organize/SeriesInfoSection";
import { SourceList, type SourceProblem } from "./organize/SourceList";
import { OrganizeLog } from "./OrganizeLog";
import { PlanActions } from "./PlanActions";
import { PlanList, sizeLabel, type TrashTarget } from "./PlanList";
import { type EditMarks, type HandoffMode } from "./EditShortcuts";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";
import { SectionTitle } from "./ui/section-title";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";

/** 対を突き合わせるための鍵。作品名と著者の両方が同じものを 1 つと見る */
function pairKey(entry: Entry): string {
  return JSON.stringify([entry.title, entry.author]);
}

type OrganizePanelProps = {
  client: SidecarClient;
  /** いま見えている画面かどうか。隠れている間はジョブの監視を止める */
  active?: boolean;
  sources: string[];
  minimumImageCount: number;
  onSourcesChange: (paths: string[]) => void;
  outputDirectory: string;
  onOutputDirectoryChange: (path: string) => void;
  onOpenSettings: () => void;
  /** 出来たファイルを、指定した画面へ読み込んだ状態で開く */
  onOpenProduced: (path: string, mode: HandoffMode) => void;
  /**
   * 1 冊を編集する画面が本を書き換えるたびに進む世代。進んだら、近道に
   * 出す編集済みの印を読み直す（#143）
   */
  editsVersion?: number;
  onEditsReset?: (path: string) => void;
  /** 投入に足す。既に入っているものは増やさず光らせる（App が決める） */
  onAddSources: (paths: string[]) => void;
  /** エクスプローラーから窓の上へ持ってきている最中か（Tauri のドラッグ） */
  nativeDragging?: boolean;
  /** もう一度落とされて光らせている投入 */
  flashing?: ReadonlySet<string>;
};

/** 赤い行を見分ける鍵。同じ名前が何度落とされても別の行にする */
let problemSeq = 0;
const problemKey = () => `problem-${++problemSeq}`;

/** パスの末尾。赤い行には名前だけを出す */
/** 経過時間を「分:秒」で書く */
function elapsedLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 解析の途中経過で、入れ物・本・読めなかったものの数が前と同じか（#168） */
function sameAnalysis(
  current: Analysis,
  found: Omit<Analysis, "running" | "settled">,
): boolean {
  return (
    current.containers.length === found.containers.length &&
    current.books.length === found.books.length &&
    current.unreadable.length === found.unreadable.length
  );
}

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

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
  minimumImageCount,
  onSourcesChange,
  outputDirectory,
  onOutputDirectoryChange,
  onOpenSettings,
  onOpenProduced,
  editsVersion = 0,
  onEditsReset,
  onAddSources,
  nativeDragging = false,
  flashing = new Set<string>(),
}: OrganizePanelProps) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  // 利用者が直した巻数。本の鍵で覚え、解析をやり直しても消さない（段階 5）
  const [customNames, setCustomNames] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [volumes, setVolumes] = useState<VolumeCorrections>(new Map());
  // 窓の上をブラウザのドラッグが通っているか（Tauri のドラッグは App から届く）
  const [browserDragging, setBrowserDragging] = useState(false);
  const dragging = nativeDragging || browserDragging;
  // 入れられなかったもの（赤い行）。投入の一覧には入れない
  const [rejected, setRejected] = useState<SourceProblem[]>([]);
  // 辞書から返事をもらった作品名。もう一度は勧めない。断られた対は辞書に
  // 入らないままなので、これが無いと「押しても何も起きない操作」が画面に
  // 残り続ける
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());

  const [keepOriginals, setKeepOriginals] = useState(true);
  const [running, setRunning] = useState(false);
  // 実行に絡む状態の文言。実行していない間は空にして、一覧の集計に場所を譲る
  const [status, setStatus] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  // 解析で分かったこと。走査が終わるまでは入れ物も空
  const [analysis, setAnalysis] = useState<Analysis>(IDLE_ANALYSIS);
  // 最後に解析へ回した投入。外しただけの変化を見分ける（#164）
  const analyzedSources = useRef<string[]>([]);
  // 解析をやり直させる合図。投入が同じでも、整理が本をその場で作り直したら
  // 一覧の判定は古くなる（#127）
  const [analysisRound, setAnalysisRound] = useState(0);
  // 解析を始めた時刻と、1 秒ごとに進める時計（#157）。経過時間が進むことで、
  // 大きなアーカイブを読んでいる間も止まっていないと分かる
  const [analysisStarted, setAnalysisStarted] = useState(0);
  const [clock, setClock] = useState(0);

  // 利用者がチェックを触った行だけの台帳。既定（整理済みの本はオフ）は覚えず、
  // 行から毎回導き直す。画面が推し量った値まで覚えると、解析で行が組み直される
  // たびに書き潰され、利用者の選択が消える
  const [decisions, setDecisions] = useState<Decisions>(new Map());

  // 整理して出来た本。実際に出来たものだけを持ち、整理の途中から 1 冊ずつ
  // 増える（#160）。その本の行に整理済みの印と編集への近道を出す。
  // 出来た本はもう処理の対象ではないので、次に整理しても捨てずに積み増す（#172）
  const [finished, setFinished] = useState<FinishedBook[]>([]);
  // 今回の整理を始める前に出来ていた本。今回の分はこの後ろへ足す
  const earlierFinished = useRef<FinishedBook[]>([]);

  // 出力先の作品フォルダに既にある本（#178）。先着として番号を持っているので、
  // 一覧に出し、今回の本の番号はその空きから振る。整理やごみ箱で出力先が
  // 変わったら、合図を進めて読み直す
  const [outputBooks, setOutputBooks] = useState<OutputBook[]>([]);
  const [outputRound, setOutputRound] = useState(0);
  // ごみ箱へ移して番号を付け替えている最中か。この間に届いた読み直しの答えは
  // 当てない。付け替える前の答えに、付け替えた名前を重ねて当てることになる
  const changingOutput = useRef(false);

  // ごみ箱へ移そうとしている本のファイル。確かめる窓が開いている間だけ在る（#164）
  const [resetting, setResetting] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [trashing, setTrashing] = useState<TrashTarget | null>(null);

  // 整理できなかったアーカイブと、その理由。ジョブは失敗しても succeeded で
  // 終わるため、ここに出さないと処理ログを開くまで失敗に気づけない
  const [failures, setFailures] = useState<OrganizeFailure[]>([]);

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
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    paused.current = controller;
    // 隠れている間は最初から止まった状態にしておく
    if (!active) controller.abort();
    return () => controller.abort();
  }, [active]);

  // 作品名から著者を引く一式。辞書の読み込みと外部検索は絡み合っているので、
  // 状態ごと useAuthorLookup が持つ
  const {
    entries,
    title,
    author,
    authorSource,
    candidates,
    searching,
    loadEntries,
    changeTitle,
    typeAuthor,
    chooseAuthor,
  } = useAuthorLookup(client);

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
   * 投入したものを解析し直す。
   *
   * 切っ掛けは投入の中身だけにする。作品名と著者は名前の組み立てにしか
   * 効かず、一覧の名前は巻数から組み立て直すので、打つたびに目次を
   * 読み直す必要は無い。
   */
  useEffect(() => {
    const before = analyzedSources.current;
    analyzedSources.current = sources;
    if (sources.length === 0) {
      if (before.length > 0) changeTitle("");
      setCustomNames(new Map());
      setAnalysis(IDLE_ANALYSIS);
      return;
    }
    // 外しただけなら読み直さない（#164）。済んだ解析から外したぶんを除けば
    // 足りる。目次読みは重く、1 つ外すたびに全部を読み直すと、投入が大きい
    // ほど待たされる
    if (
      analysis.settled &&
      sources.length < before.length &&
      sources.every((path) => before.includes(path))
    ) {
      const removed = before.filter((path) => !sources.includes(path));
      setAnalysis((current) => withoutPaths(current, removed));
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
    // 前の整理の件数を出したままにしない
    setProgress({ current: 0, total: 0 });
    const startedAt = Date.now();
    setAnalysisStarted(startedAt);
    setClock(startedAt);
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
            const found = analysisResult(snapshot.result);
            setAnalysis((current) => ({
              running:
                snapshot.state === "queued" || snapshot.state === "running",
              settled: snapshot.state === "succeeded",
              // RAR の中の進み（reading）だけが動いた応答では、入れ物と本の並びを
              // 前のまま使う（#168）。並びを新しくすると一覧を組み直して全部の行を
              // 描き直すことになり、大きな RAR を読む間ずっと画面が重くなる。
              // 1 回の解析の中では入れ物も本も増えるだけなので、数で見分けられる
              ...(sameAnalysis(current, found)
                ? {
                    containers: current.containers,
                    books: current.books,
                    unreadable: current.unreadable,
                  }
                : found),
              reading: found.reading,
            }));
            setProgress({ current: snapshot.current, total: snapshot.total });
          },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          const found = analysisResult(job.result);
          // 最後の途中経過で本が出そろっていれば、並びを前のまま使う（#168）。
          // 終わった瞬間に全部の行を描き直さず、主操作がすぐ押せるようにする
          setAnalysis((current) => ({
            running: false,
            settled: job.state === "succeeded",
            ...(sameAnalysis(current, found)
              ? {
                  containers: current.containers,
                  books: current.books,
                  unreadable: current.unreadable,
                }
              : found),
            reading: found.reading,
          }));
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        // 断られたパスは赤い行へ移し、残りで解析し直す（#107）。1 件でも
        // 断られると投入全体が通らないので、黙っていると何も解析されない
        const refused = refusedPaths(error);
        const kept = sources.filter(
          (path) => !refused.some((item) => item.path === path),
        );
        if (kept.length < sources.length) {
          setRejected((current) => [
            ...current,
            ...refused.map((item) => ({
              key: problemKey(),
              name: baseName(item.path),
              reason: item.reason,
            })),
          ]);
          onSourcesChange(kept);
          return;
        }
        // 解析できなくても投入そのものは生きている。行はそのまま残し、
        // 実行時に展開してみて分かる結果に委ねる
        setAnalysis(IDLE_ANALYSIS);
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
  }, [client, sources, analysisRound]);

  /**
   * 窓のどこに落としても投入に入れる。
   *
   * 落とす先を 360px の箱に限ると、狙って落とす手間を利用者に払わせる。
   * Tauri のドロップは窓に届くので、ブラウザの経路も窓で受けて揃える。
   * 隠れている間は受けない（別の画面へのドロップを横取りしない）。
   */
  const dropInto = useRef<(transfer: DataTransfer) => void>(() => undefined);
  dropInto.current = (transfer) => {
    if (running) return;
    void resolveDroppedPaths(client, transfer).then(
      ({ paths, problems: failed }) => {
        if (failed.length > 0) {
          setRejected((current) => [
            ...current,
            ...failed.map((problem) => ({ key: problemKey(), ...problem })),
          ]);
        }
        if (paths.length > 0) onAddSources(paths);
      },
    );
  };

  useEffect(() => {
    if (!active) return;
    const over = (event: DragEvent) => {
      event.preventDefault();
      setBrowserDragging(true);
    };
    // 要素の間を移るたびにも届く。窓の外へ出たときだけ（行き先が無い）消す
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) setBrowserDragging(false);
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      setBrowserDragging(false);
      if (event.dataTransfer) dropInto.current(event.dataTransfer);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      setBrowserDragging(false);
    };
  }, [active]);

  // 出力先にある本を読み直す（#178）。作品名と著者は打つたびに変わるので、
  // 打ち終わるのを少し待ってから聞きに行く
  useEffect(() => {
    if (!outputDirectory.trim() || !title.trim() || !author.trim()) {
      setOutputBooks([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      client
        .outputBooks(outputDirectory, title, author)
        .then((found) => {
          if (alive && !changingOutput.current) setOutputBooks(found);
        })
        // 出力先を選び直す前などは断られる。一覧に出ないだけで、整理はできる
        .catch(() => {
          if (alive) setOutputBooks([]);
        });
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [client, outputDirectory, title, author, outputRound]);

  // 解析の間だけ時計を進める
  useEffect(() => {
    if (!analysis.running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [analysis.running]);

  // 中身の変わっていない行は前の行をそのまま使い、一覧が描き直さずに済む
  // ようにする（#168）
  const previousRows = useRef<PlanRow[]>([]);
  const analyzedRows = useMemo(() => {
    const next = reuseRows(
      previousRows.current,
      buildPlanRows(
        sources,
        analysis.containers,
        analysis.books,
        analysis.unreadable,
      ),
    );
    previousRows.current = next;
    return next;
  }, [sources, analysis.containers, analysis.books, analysis.unreadable]);
  // 一覧に出す、出力先に既にある本（#178）。この画面で作った本は作った行の
  // 側で、投入したものの中にある本は投入の側の行で出ているので、二重に出さない。
  // 何も投入していない間は出さない（一覧そのものが空の案内になっている）
  const shownOutput = useMemo(() => {
    if (sources.length === 0) return [];
    const made = new Set(finished.map((book) => book.path));
    return outputBooks.filter(
      (book) =>
        !made.has(book.path) &&
        !sources.some(
          (source) => source === book.path || isInside(source, book.path),
        ),
    );
  }, [outputBooks, finished, sources]);
  // 出来ている本。この画面で作った本と、出力先に既にある本（#178）
  const doneBooks = useMemo<FinishedBook[]>(
    () => [
      ...finished,
      ...shownOutput.map((book) => ({
        source: book.path,
        entry: "",
        path: book.path,
        size: book.size,
      })),
    ],
    [finished, shownOutput],
  );
  // 直した巻数を当てた行。名前・印・依頼・冊数は全部こちらから作る
  const rows = useMemo(
    () =>
      withOutputBooks(
        applyVolumes(analyzedRows, volumes),
        shownOutput,
        author,
        title,
      ),
    [analyzedRows, volumes, shownOutput, author, title],
  );

  // 近道に出す編集済みの印（#143）。相手は近道を置く本、つまり整理済みの行と
  // 出来たファイル。並びが変わったときと、1 冊を編集する画面が本を書き換えた
  // ときに読み直す。鍵は 1 本の文字列にまとめ、描画のたびに配列が作り直されても
  // 問い合わせが重ならないようにする
  const [edits, setEdits] = useState<EditMarks>({});
  const editTargets = [
    ...new Set([
      ...rows
        .filter((row) => row.kind === "book" && row.organized)
        .map((row) => row.source),
      ...doneBooks.map((book) => book.path),
    ]),
  ].join("\n");
  useEffect(() => {
    if (!editTargets) return;
    let alive = true;
    client
      .edits(editTargets.split("\n"))
      .then((found) => {
        if (alive) setEdits(found);
      })
      // 印が出ないだけで、整理も近道もそのまま使える
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, editTargets, editsVersion]);
  // いま外れている葉。触った覚えと既定から毎回導き直すので、解析中に外した
  // 入れ物へ後から本が生えても、その本は外れたまま出る。1 度だけ導いて、
  // 読む所すべてで同じものを使う
  // 整理して出来た本の行・出力先に既にある本の行 → 出来ている本（#160 #178）
  const made = useMemo(
    () => new Map(doneBooks.map((book) => [bookId(book), book])),
    [doneBooks],
  );
  // 出来た本は、もう処理の対象ではない（#172）。チェックを出さず、外れている
  // 側に入れる。入れたままだと、もう一度押したときに _1 の写しが出来る
  const off = useMemo(() => {
    const decided = effectiveOff(rows, decisions, made, minimumImageCount);
    if (made.size === 0) return decided;
    return new Set([...decided, ...made.keys()]);
  }, [rows, decisions, made, minimumImageCount]);
  // 出来ている本の名前は先着として埋まっている（#178）
  const names = useMemo(
    () =>
      outputNames(
        rows,
        author,
        title,
        off,
        decisions,
        doneBooks.map((book) => baseName(book.path)),
        customNames,
      ),
    [rows, author, title, off, decisions, doneBooks, customNames],
  );
  // 同じ巻の本の数（#162）。外した本も数える
  const sameVolume = useMemo(
    () => sameVolumeCounts(rows, author, title),
    [rows, author, title],
  );
  // 作る本どうしで名前が重なる本。後ろの本は黙って _1 で出来てしまう
  const collided = useMemo(
    () => collidingBooks(rows, off, author, title, made),
    [rows, off, author, title, made],
  );
  // 直した巻数のうち、実際に作られる本のもの。状態の行で数える
  const correctedCount = rows.filter(
    (row) =>
      row.kind === "book" &&
      !row.organized &&
      volumes.has(row.id) &&
      !off.has(row.id),
  ).length;
  const keptCount = keptBooks(rows, off).length;
  // 出来た本は「外した」ではなく「整理済み」に数える（#172）。入れ直した
  // 整理済みの本は、もともと整理済みの側に数えている
  const madeCount = rows.filter(
    (row) => made.has(row.id) && !row.organized,
  ).length;
  const droppedCount = droppedBookCount(rows, off) - madeCount;
  const organizedCount = organizedSkippedCount(rows, off) + madeCount;
  const issues = [
    ...keptIssueCounts(rows, off),
    ...(collided.size > 0
      ? [{ issue: VOLUME_DUPLICATE, count: collided.size }]
      : []),
  ];
  // 実際に何かが作られる単位。作る本が 1 つも無いことと、左の列が要るかを
  // どちらもここから決める
  const keptLeafCount = keptLeafRows(rows, off).length;
  const namelessCount = namelessKeptRows(rows, off).length;
  const needsName = needsSeriesName(rows, off);
  // 右の見出しに出す冊数。外した本も整理済みの本も、一覧に並ぶ本は全部数える
  const bookCount = rows.filter((row) => row.kind === "book").length;
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
    if (sources.length === 0)
      return ["左の「投入したもの」にフォルダかアーカイブを入れてください"];
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

  /**
   * チェックを付け外しする。親を触ったら下の葉をまとめて動かす。
   *
   * 入れるときは、同じ巻で既定で選ばれている本も入れたと覚えてから入れる
   * （#166）。覚えないと、1 冊足したつもりが入れ替えになる
   */
  const toggleRows = (targets: PlanRow[], keep: boolean) => {
    const leaves = targets.flatMap(toggleTargets);
    setDecisions((current) =>
      toggleLeaves(
        keep
          ? keepPicked(rows, current, leaves, made, minimumImageCount)
          : current,
        leaves,
        keep,
      ),
    );
  };

  /** 一覧ごとまとめて付け外しする。主操作の行の全体チェックが使う */
  const toggleAll = (keep: boolean) => toggleRows(rows, keep);

  /** 同じ巻を 1 冊ずつに絞る / 全部入れる（#169） */
  const toggleOneEach = (one: boolean) => {
    setDecisions((current) => setOneEach(rows, current, one, made));
  };

  const belowMinimumRows = rows.filter(
    (row) =>
      row.kind === "book" &&
      row.imageCount !== null &&
      row.imageCount < minimumImageCount &&
      !made.has(row.id),
  );
  const minimumOnly =
    minimumImageCount > 0 && belowMinimumRows.every((row) => off.has(row.id));
  const toggleMinimum = (only: boolean) => {
    setDecisions((current) =>
      toggleLeaves(
        current,
        belowMinimumRows.map((row) => row.id),
        !only,
      ),
    );
  };
  const toggleMostImages = (one: boolean) => {
    setDecisions((current) =>
      selectMostImages(
        rows,
        current,
        one,
        made,
        minimumOnly ? minimumImageCount : 0,
      ),
    );
  };

  /**
   * 巻数を直す。自動で読んだ値と同じにしたら、直していないことに戻す。
   * 戻す手を別に置かなくても、元の数字を打ち直せば戻る。
   */
  const correctVolume = (row: PlanRow, volume: number | null) => {
    setVolumes((current) => {
      const next = new Map(current);
      if (volume === row.autoVolume) next.delete(row.id);
      else next.set(row.id, volume);
      return next;
    });
  };

  /** 直したうえで、同じ入れ物の下の本に続き番号を振る */
  const fillVolumes = (row: PlanRow, volume: number) => {
    const following = numberFollowing(analyzedRows, row.id, volume);
    setVolumes((current) => {
      const next = new Map(current);
      for (const [id, value] of new Map([[row.id, volume], ...following])) {
        const auto = analyzedRows.find((item) => item.id === id)?.autoVolume;
        if (value === auto) next.delete(id);
        else next.set(id, value);
      }
      return next;
    });
  };

  /** 投入したものを外す。実行中は中身を変えさせない */
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
    // 投入した本の入れ物。整理が本をその場で作り直したかを、終わってから見分ける
    const analyzed = new Set(analysis.books.map((book) => book.source));

    try {
      const job = await client.waitForJob(
        id,
        (snapshot) => {
          // 総数はサイドカーが投入時に決める。フォルダは中身へ展開され、
          // 外した本のぶんも引かれるので、画面の件数で補うと食い違う（#65）
          setProgress({ current: snapshot.current, total: snapshot.total });
          setLog(snapshot.log ?? []);
          // 出来た本から、その行で編集へ移れるようにする。全部済むのを待たない
          setFinished([
            ...earlierFinished.current,
            ...organizeResult(snapshot.result).finished,
          ]);
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
      setFinished([...earlierFinished.current, ...outcome.finished]);
      setFailures(outcome.failed);
      // 投入した本そのものが作り直された（行き先が自分自身だった）なら、
      // 一覧はまだ作り直す前の判定を見せている。解析し直して新しい姿にする。
      // それ以外の実行では投入は変わっていないので、読み直さない
      if (outcome.produced.some((path) => analyzed.has(path))) {
        setAnalysisRound((round) => round + 1);
      }
      // 番号を詰め終えるまでは実行中のまま（ごみ箱も出さない）。終わりを
      // 告げてから詰めると、その間に押されたごみ箱の詰め直しと重なる
      const summary = organizeSummary(
        outcome.produced.length,
        outcome.failed.length,
      );
      const settled = await settleNumbers([
        ...earlierFinished.current,
        ...outcome.finished,
      ]);
      // 詰め直せなかったときは、その理由を settleNumbers が出している
      if (settled === "renamed")
        setStatus(`${summary}。同じ巻の番号を詰め直しました`);
      else if (settled === "unchanged") setStatus(summary);
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
        // 出力先に本が増えた。出力先の一覧を読み直す（#178）
        setOutputRound((round) => round + 1);
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
    // 前回出来た本は残す。今回の対象から外れているので、作り直しはしない
    earlierFinished.current = finished;
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
        books: selectedBooks(rows, off, volumes, names, customNames),
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
   * 確かめた本のファイルをごみ箱へ移し、一覧から外す（#164）。
   *
   * 整理して出来たファイルなら、その行は整理する前の姿へ戻り、チェックも
   * 外す（消した本をまた作らない）。元のアーカイブなら、解析の結果から除く。
   * 読み直さない。
   *
   * 出来ている本を消したら、同じ巻の残りの番号を先着順に詰め直す（#178）。
   * 1 冊に絞れば、残った本は番号なしになる。
   */
  const trash = async (target: TrashTarget) => {
    setTrashing(null);
    try {
      await client.trashFile(target.path);
    } catch (error) {
      setStatus(sidecarReason(error));
      return;
    }
    const madeBook = finished.find((book) => book.path === target.path);
    if (madeBook) {
      setDecisions((current) =>
        toggleLeaves(current, [bookId(madeBook)], false),
      );
    }
    const remaining = finished.filter((book) => book.path !== target.path);
    setFinished(remaining);
    setOutputBooks((current) =>
      current.filter((book) => book.path !== target.path),
    );
    setAnalysis((current) => withoutPaths(current, [target.path]));
    if (sources.includes(target.path)) {
      onSourcesChange(sources.filter((path) => path !== target.path));
    }
    const moved = `${baseName(target.path)} をごみ箱へ移しました`;
    setStatus(moved);
    if ((await settleNumbers(remaining, target.path)) === "renamed") {
      setStatus(`${moved}。同じ巻の残りの番号を詰め直しました`);
    }
  };

  /**
   * 出来ている本の番号を、同じ巻ごとに先着順の 無印 → _1 → _2 に詰める（#178）。
   *
   * 出力先は画面が覚えている一覧ではなく、その場で読み直した中身を見る。
   * 付け替えが一度しくじって番号が飛んだまま残っても（出力先が同期中の
   * フォルダで、作った直後のファイルが掴まれていた等）、次にごみ箱へ移したり
   * 整理したりしたときに詰まる。
   *
   * この間に届いた出力先の読み直しは当てない。付け替える前の答えに、
   * 付け替えた名前を重ねて当てることになる。終わってから読み直す。
   *
   * 詰め直したか・詰めるものが無かったか・しくじったか（理由はここで状態の
   * 行に出す）を返す。``removed`` は消したばかりのファイル（同期中の
   * フォルダでは、消した直後もしばらく一覧に残ることがある）。
   */
  const settleNumbers = async (
    made: FinishedBook[],
    removed = "",
  ): Promise<"renamed" | "unchanged" | "failed"> => {
    changingOutput.current = true;
    try {
      const found =
        outputDirectory.trim() && title.trim() && author.trim()
          ? await client
              .outputBooks(outputDirectory, title, author)
              .catch(() => [] as OutputBook[])
          : [];
      // 投入したものの中のファイルは付け替えない。投入の行が指す先が消える
      const paths = [
        ...new Set([...made, ...found].map((book) => book.path)),
      ].filter(
        (path) =>
          path !== removed &&
          !sources.some((source) => source === path || isInside(source, path)),
      );
      const renames = compaction(paths);
      if (renames.length === 0) return "unchanged";
      await client.renameFiles(renames);
      const moved = new Map(
        renames.map((rename) => [rename.source, rename.target]),
      );
      const rename = <T extends { path: string }>(book: T): T => {
        const next = moved.get(book.path);
        return next ? { ...book, path: next } : book;
      };
      // 読み直しを待たずに新しい名前で出す
      setFinished((current) => current.map(rename));
      setOutputBooks((current) => current.map(rename));
      return "renamed";
    } catch (error) {
      setStatus(`番号を詰め直せませんでした: ${sidecarReason(error)}`);
      return "failed";
    } finally {
      changingOutput.current = false;
      setOutputRound((round) => round + 1);
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
  // 解析中に出す 1 行（#157）。何を読んでいるかと経過時間を言う。走査が
  // 終わっていれば、読み終えた数の次の入れ物がいま読んでいるもの
  const reading = analysis.containers[progress.current];
  const analysisStatus =
    `解析しています… ${
      reading
        ? `${baseName(reading)} を読んでいます`
        : "投入したものを調べています"
    } · 経過 ` +
    elapsedLabel(Math.max(0, Math.floor((clock - analysisStarted) / 1000)));
  const blockedBy = running
    ? "実行中です"
    : analysis.running
      ? analysisStatus
      : problems.join(" / ");
  const blocked = blockedBy !== "";
  // 作品名・著者が要るのに空の欄（#175）。欄そのものに印を付ける。押せない
  // 理由が主操作の横だけだと、解析が終わっていないのと見分けにくい
  const nameRequired = keptLeafCount > 0 && needsName && !running;
  const titleMissing = nameRequired && !title.trim();
  const authorMissing = nameRequired && !author.trim();

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
      : planSummary(keptCount, droppedCount, organizedCount) +
        (correctedCount > 0 ? ` · ${correctedCount} 冊の巻数を直した` : ""));

  return (
    /*
      ワークベンチ型。入れるもの（作品情報・投入・出力先）は幅の決まった
      左の列に、出来上がるものは残り全部を使う右の一覧に置く。投入と結果を
      同じ面に置くと、何を入れたのかと何が出来るのかが混ざって見える。
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
        左の列。上から 作品情報 / 投入したもの / オプション の 3 段。作品名と
        著者は大前提なので先頭に置き、出力先は底に置く。この 2 段は高さを
        変えず、何件入れるか分からない投入の箱だけが窓の高さに追従する。
        列そのものはスクロールさせない。溢れるのは投入の箱の中だけ。
      */}
      <aside
        className="flex min-h-0 w-[360px] shrink-0 flex-col gap-4"
        data-testid="organize-sidebar"
      >
        <SeriesInfoSection
          title={title}
          author={author}
          authorSource={authorSource}
          candidates={candidates}
          searching={searching}
          sourceCount={sources.length}
          keptLeafCount={keptLeafCount}
          namelessCount={namelessCount}
          titleMissing={titleMissing}
          authorMissing={authorMissing}
          onChangeTitle={changeTitle}
          onTypeAuthor={typeAuthor}
          onChooseAuthor={chooseAuthor}
          onOpenLibrary={() => changeLibraryOpen(true)}
        />

        <FilePicker
          client={client}
          selected={sources}
          onChange={(paths) => {
            // 空にするのは「空にする」だけ。赤い行も一緒に片付ける
            if (paths.length === 0) setRejected([]);
            onSourcesChange(paths);
          }}
          disabled={running}
          fill
          dragging={dragging && !running}
          list={
            sources.length > 0 || rejected.length > 0 ? (
              <SourceList
                sources={sources}
                rows={rows}
                analysis={analysis}
                problems={rejected}
                flashing={flashing}
                disabled={running}
                onRemove={removeSource}
                onDismissProblem={(key) =>
                  setRejected((current) =>
                    current.filter((problem) => problem.key !== key),
                  )
                }
              />
            ) : undefined
          }
        />

        <OptionsSection
          client={client}
          outputDirectory={outputDirectory}
          onOutputDirectoryChange={onOutputDirectoryChange}
          onOpenSettings={onOpenSettings}
          keepOriginals={keepOriginals}
          onKeepOriginalsChange={setKeepOriginals}
        />
      </aside>

      {/*
        作業面。出来上がる本の一覧が高さいっぱいを取り、実行の結果だけが
        下に居場所を持つ。失敗と出来たファイルは処理ログの真上に置く。
        どれも「実行して何が起きたか」を見る所で、離すと目が往復する。
      */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <section className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex h-7 shrink-0 items-center gap-2">
            <SectionTitle>出来上がる本</SectionTitle>
            <span
              className="tabular text-[12px] text-ink-faint"
              data-testid="plan-count"
            >
              {bookCount} 冊
            </span>
            {sources.length > 0 ? (
              <span className="min-w-0 truncate text-[11.5px] text-ink-faint">
                チェックを外すと作りません · 入れたものごと外すのは左の ×
              </span>
            ) : null}
          </div>
          {/* 主操作は一覧の直上。押したら何が起きるかを一覧のすぐ上で読む（#68・#70） */}
          <PlanActions
            rows={rows}
            excluded={off}
            done={made}
            status={statusText}
            statusTitle={hasOrganized ? ORGANIZED_STATUS_TIP : undefined}
            issues={issues}
            progress={progress}
            partial={analysis.running ? analysis.reading : 0}
            running={running}
            blocked={blocked}
            warning={
              !status && !analysis.running && (titleMissing || authorMissing)
            }
            onToggleAll={toggleAll}
            oneEach={oneEachState(rows, off, made)}
            onToggleOneEach={toggleOneEach}
            mostImages={mostImagesState(rows, off, made)}
            onToggleMostImages={toggleMostImages}
            minimumOnly={minimumOnly}
            minimumImageCount={minimumImageCount}
            onToggleMinimum={toggleMinimum}
            onOpenSettings={onOpenSettings}
            onRun={run}
            onCancel={cancel}
          />
          {/* 何も入れていないときは落とす先ではなく出来上がりの予告。点線は
              左の落とす箱だけの印なので、ここは空でも実線にする */}
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col rounded-card border bg-surface/50 transition-colors",
              // ドラッグ中は枠だけ変える。中身は隠さない（落とせば左に入る）
              dragging && !running ? "border-brand" : "border-line",
            )}
            data-testid="plan-box"
            data-dragging={String(dragging && !running)}
          >
            {sources.length === 0 ? (
              <Empty
                className="m-auto"
                icon={<BookMarked />}
                title="出来上がる本がここに並びます"
              >
                左の「投入したもの」にフォルダかアーカイブを入れると、出来上がる本を
                1
                冊ずつ確かめてから整理できます。この窓のどこに落としても左に入ります。
              </Empty>
            ) : (
              <PlanList
                rows={rows}
                excluded={off}
                names={names}
                outputDirectory={outputDirectory}
                locked={running || resetBusy}
                onToggle={toggleRows}
                made={made}
                sameVolume={sameVolume}
                onTrash={setTrashing}
                onReset={(path) => {
                  setResetting(path);
                }}
                // 整理済みの行の近道は、いまディスク上に在るファイルを渡す。
                // 整理して出来た本の行なら、出来たファイル
                onOpenArchive={onOpenProduced}
                edits={edits}
                corrected={new Set(volumes.keys())}
                renamed={new Set(customNames.keys())}
                collided={collided}
                onRename={(row, name) =>
                  setCustomNames((current) => {
                    const next = new Map(current);
                    if (name === null) next.delete(row.id);
                    else next.set(row.id, name);
                    return next;
                  })
                }
                onCorrect={correctVolume}
                onFill={fillVolumes}
              />
            )}
          </div>
        </section>
        {/*
          失敗は出来たファイルより先に置く。放っておけないのはこちらで、
          出来たぶんの一覧に押し下げられて見落とすと元も子もない。
        */}
        <FailedList failures={failures} />
        <OrganizeLog lines={log} />
      </div>

      {resetting ? (
        <EditRestoreDialog
          client={client}
          archive={resetting}
          mode="all"
          onClose={() => setResetting(null)}
          onBusy={setResetBusy}
          onRestored={(result) => {
            setStatus(
              result.complete
                ? `${baseName(resetting)} の編集を元に戻しました`
                : `${baseName(resetting)} の復元できる加工を戻しました。記録のない編集は残ります。`,
            );
            if (result.complete)
              setEdits((current) => ({ ...current, [resetting]: [] }));
            setAnalysisRound((round) => round + 1);
            setOutputRound((round) => round + 1);
            onEditsReset?.(resetting);
          }}
        />
      ) : null}

      {/* 消す前に確かめる（#164）。押し間違えても取り戻せるよう、消すのでは
          なくごみ箱へ移す */}
      <Dialog
        open={trashing !== null}
        onOpenChange={(open) => {
          if (!open) setTrashing(null);
        }}
      >
        <DialogContent
          data-testid="trash-dialog"
          className="w-[min(32rem,92vw)] gap-3 p-4"
        >
          <DialogTitle className="text-[14px] font-semibold">
            このファイルをごみ箱へ移しますか
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-ink-muted">
            {trashing
              ? `${baseName(trashing.path)}${
                  trashing.size !== null
                    ? `（${sizeLabel(trashing.size)}）`
                    : ""
                }`
              : ""}
          </DialogDescription>
          <p
            className="truncate text-[11.5px] text-ink-faint"
            title={trashing?.path}
          >
            {trashing?.path}
          </p>
          {/* 主操作を右端に置く。最初のフォーカスは先頭の「やめる」に当たる。
              Enter 1 つで消えてしまわないように */}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              data-testid="trash-cancel"
              onClick={() => setTrashing(null)}
            >
              やめる
            </Button>
            <Button
              variant="danger"
              data-testid="trash-confirm"
              onClick={() => trashing && void trash(trashing)}
            >
              ごみ箱へ移す
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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
