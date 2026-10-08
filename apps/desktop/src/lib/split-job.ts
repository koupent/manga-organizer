import { useEffect, useRef, useState } from "react";
import {
  sidecarReason,
  type CoverRequest,
  type SidecarClient,
} from "../api/client";
import { firstImageGeneration } from "./utils";
import {
  confirmResultOf,
  doneMessage,
  intentRows,
  restoredRows,
  rowsFrom,
  scanResultOf,
  type SplitRow,
} from "./split";

/**
 * ページ分割の、サイドカーとのやり取り（#58 段階 3）。
 *
 * 開いたときの走査と、確定の書き込みは、どちらも秒の単位で走る長いジョブで、
 * 走っている最中の始末（押させない・見捨てたぶんを止める）まで含めて 1 つの
 * 決まりごとになっている。描画の都合と混ぜると、その決まりごとが画面の
 * あちこちに散り、どこか 1 つだけ直し忘れた形で壊れる。
 */

/** 状態欄の状態。画面の外（E2E）からも読めるようにしておく */
export type ReportState = "idle" | "running" | "done" | "error";
export type Report = { state: ReportState; message: string };

const NOTHING: Report = { state: "idle", message: "" };

type SplitJobOptions = {
  client: SidecarClient;
  archive: string;
  /** アーカイブを書き換えたことを伝える。他の画面が持つページは古くなる */
  onArchiveChanged?: () => void;
};

export type SplitJob = {
  /** 並べる行。走査が終わるまでは null */
  rows: SplitRow[] | null;
  /** いまのページ数。走査が数えたもの */
  pageCount: number;
  progress: { current: number; total: number };
  report: Report;
  /**
   * 書き込みと、その後の読み直しが終わるまで立つ印。
   *
   * 報告の状態では代わりにならない。書き終えて（done）から新しい行が並ぶまでの
   * 隙が空いていて、そこで主操作が生き返る。
   */
  busy: boolean;
  /** 絵の URL に添える世代。書き込むと同じ URL が別の絵を指す */
  reloadKey: number;
  editRows: (next: SplitRow[]) => void;
  /** 保留を全部捨て、開いたときの姿へ戻す */
  restore: () => void;
  /** 保留を書き込む。書き込めたかを返す（①から②へ進むかを決める） */
  confirm: (cover?: CoverRequest) => Promise<boolean>;
  reordered: boolean;
  refresh: () => void;
};

export function useSplitJob({
  client,
  archive,
  onArchiveChanged,
}: SplitJobOptions): SplitJob {
  const [rows, setRows] = useState<SplitRow[] | null>(null);
  const originalRows = useRef<SplitRow[]>([]);
  // 走査が返した印とページ数。確定はこの印を添えて投げる
  const [scan, setScan] = useState({ token: "", pageCount: 0 });
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [report, setReport] = useState<Report>(NOTHING);
  const [busy, setBusy] = useState(false);
  // 書き込むと連番が振り直され、同じ URL が別の絵を指す。ここを進めて読み直させる
  const [reloadKey, setReloadKey] = useState(firstImageGeneration);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    // 走査は数百枚を 1 枚ずつ開く。番号が返るより先に画面を離れることがあるので、
    // OrganizePanel の run() / cancel() と同じように「見限った」ことを残しておき、
    // 番号を得た直後に止める
    let scanId: string | null = null;
    let abandoned = false;
    const stopScan = () => {
      if (scanId) void client.cancelJob(scanId).catch(() => undefined);
    };

    setProgress({ current: 0, total: 0 });
    client
      .splitScan(archive)
      .then((accepted) => {
        scanId = accepted.id;
        if (abandoned) {
          stopScan();
          return null;
        }
        return client.waitForJob(
          accepted.id,
          (job) => {
            if (alive) setProgress({ current: job.current, total: job.total });
          },
          { signal: controller.signal },
        );
      })
      .then((job) => {
        if (job === null) return;
        // 結果を受け取った走査は、もう止める相手ではない
        scanId = null;
        if (!alive) return;
        if (job.state !== "succeeded") {
          throw new Error(job.error ?? "見開きを調べられませんでした");
        }
        const result = scanResultOf(job.result);
        setScan({ token: result.token, pageCount: result.page_count });
        originalRows.current = rowsFrom(result);
        setRows(originalRows.current);
        // 新しい行が並んで初めて、書き込みは本当に終わり
        setBusy(false);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setReport({ state: "error", message: sidecarReason(error) });
        // ここで印を降ろさない。この走査は 2 通りある。開いたときの走査なら
        // 行は 1 つも並んでおらず、印はそもそも立っていない（降ろす意味が無い）。
        // もう 1 つ、書き込みが通った後の走査で失敗したときは、並んでいるのは
        // 書き込む前の行――もう本には無い名前と、使い終えた走査の印――になる。
        // 降ろすと確定が生き返り、利用者は割れなかったと思って押し直す。
        // 送られるのは古い印と古い名前で、通ってしまえば割った半分をさらに
        // 割った本が残る。印を降ろすのは、新しい行が並んだときだけでよい
      });

    return () => {
      // 画面を離れた後も問い合わせが続くと、戻ってきたときに同じ本へ
      // 二重にジョブを投入できてしまう
      alive = false;
      abandoned = true;
      controller.abort();
      // 待つのをやめるだけでは、サイドカーの走査は止まらない。誰も見ていない
      // 全ページの走査が裏で走り続け、次に選んだ本の走査と重なって、どちらも
      // 待たされる
      stopScan();
    };
  }, [client, archive, reloadKey]);

  /**
   * 保留中の内容を入れ替える。
   *
   * 書き込みの報告は、次の編集を始めた時点で古くなる。そのまま残すと
   * 「5 枚を分割しました」と出たままチェックを変えられ、いま押すと何が
   * 起きるのかが読めなくなる。
   *
   * ただし走っている最中の報告は消さない。消すと「保存しています...」が
   * 途中で引っ込み、走っていないように見える。
   */
  const editRows = (next: SplitRow[]) => {
    setRows(next);
    setReport((current) =>
      current.state === "idle" || current.state === "running"
        ? current
        : NOTHING,
    );
  };

  const restore = () => {
    if (!rows) return;
    setRows(restoredRows(originalRows.current));
    setReport(NOTHING);
  };

  const confirm = async (cover?: CoverRequest) => {
    if (!rows || busy) return false;
    // 押した瞬間から立てる。書き込みが終わって新しい行が並ぶまで降ろさない
    setBusy(true);
    setReport({ state: "running", message: "保存しています..." });
    try {
      const accepted = await client.applySplit({
        archive,
        token: scan.token,
        // 行は差分ではなくページ順に全部を送る。サイドカーが
        // 「名前を並べたもの＝いまのページ順」を照合できる
        rows: intentRows(rows),
        allow_reorder: true,
        reviewed: true,
        cover: cover ?? null,
      });
      const job = await client.waitForJob(accepted.id);
      if (job.state !== "succeeded") {
        throw new Error(job.error ?? "保存に失敗しました");
      }
      const result = confirmResultOf(job.result);
      const transformed =
        result.split_count +
        result.restored_count +
        result.adjusted_count +
        result.joined_count +
        result.merged_count;
      setReport({
        state: "done",
        message: transformed
          ? doneMessage(result)
          : "確認済みとして保存しました · " + doneMessage(result),
      });
      onArchiveChanged?.();
      // 割った対はまた 1 行に畳まれて戻ってくる。読み直して、確定した直後と
      // 開き直したときが同じ画面になるようにする
      setReloadKey((key) => key + 1);
      return true;
    } catch (error: unknown) {
      // 断られた確定は 1 バイトも書いていない。保留中のチェックと線は
      // そのまま残し、直して押し直せるようにする
      setReport({ state: "error", message: sidecarReason(error) });
      setBusy(false);
      return false;
    }
  };

  return {
    rows,
    pageCount: scan.pageCount,
    progress,
    report,
    busy,
    reloadKey,
    editRows,
    restore,
    confirm,
    refresh: () => {
      setBusy(true);
      setReloadKey((key) => key + 1);
    },
    reordered:
      JSON.stringify(rows?.flatMap((row) => row.names)) !==
      JSON.stringify(originalRows.current.flatMap((row) => row.names)),
  };
}
