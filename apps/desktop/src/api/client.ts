import type { paths } from "./schema";

/** サイドカーへの接続情報。Tauri シェルが起動時に受け取り、ここへ渡す */
export type SidecarConnection = {
  baseUrl: string;
  token: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type PagesResponse =
  paths["/api/pages"]["get"]["responses"][200]["content"]["application/json"];
type CoverResponse =
  paths["/api/cover"]["get"]["responses"][200]["content"]["application/json"];
type JobResponse =
  paths["/api/jobs/{job_id}"]["get"]["responses"][200]["content"]["application/json"];
type HealthResponse =
  paths["/api/health"]["get"]["responses"][200]["content"]["application/json"];
type OrganizeRequest =
  paths["/api/jobs/organize"]["post"]["requestBody"]["content"]["application/json"];
type CoverRequest =
  paths["/api/jobs/cover"]["post"]["requestBody"]["content"]["application/json"];
type OutputRoot =
  paths["/api/output-roots"]["post"]["responses"][200]["content"]["application/json"];
type Trashed =
  paths["/api/files/trash"]["post"]["responses"][200]["content"]["application/json"];
type OutputBooks =
  paths["/api/output/books"]["post"]["responses"][200]["content"]["application/json"];
/** 出力先に既にある、整理の規則どおりの名前の本 1 冊（#178） */
export type OutputBook = OutputBooks["books"][number];
type Renamed =
  paths["/api/files/rename"]["post"]["responses"][200]["content"]["application/json"];
/** ファイル 1 つの名前の付け替え（#178） */
export type Rename = Renamed["renames"][number];
type LibraryEntries =
  paths["/api/library/entries"]["get"]["responses"][200]["content"]["application/json"];
/** 辞書の 1 件。作品名と著者の対 */
export type LibraryEntry =
  paths["/api/library/entries"]["post"]["requestBody"]["content"]["application/json"];
export type LibraryImportResult =
  paths["/api/library/import"]["post"]["responses"][200]["content"]["application/json"];
type Suggestion =
  paths["/api/library/suggest"]["post"]["responses"][200]["content"]["application/json"];
type BrowseResult =
  paths["/api/browse"]["get"]["responses"][200]["content"]["application/json"];
type ResolveResult =
  paths["/api/resolve"]["post"]["responses"][200]["content"]["application/json"];
type JobAccepted =
  paths["/api/jobs/reorder"]["post"]["responses"][202]["content"]["application/json"];
export type SplitConfirmRequest =
  paths["/api/jobs/split"]["post"]["requestBody"]["content"]["application/json"];
type EditsResponse =
  paths["/api/edits"]["post"]["responses"][200]["content"]["application/json"];

/**
 * 失敗の理由だけを取り出す。
 *
 * 断られた要求の本文は `{"detail":"..."}` という JSON で届く。そのまま状態欄へ
 * 出すと、利用者は理由を JSON の殻ごと読まされる。読める理由が取り出せない
 * ときは、握り潰さずに元の文字列を返す。
 */
export function sidecarReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { detail?: unknown }).detail === "string"
    ) {
      return (parsed as { detail: string }).detail;
    }
  } catch {
    // JSON でなければ、そのままの文字列が理由
  }
  return raw;
}

/** ジョブ待ちの調整。signal で呼び出し側から打ち切れる */
type WaitForJobOptions = {
  intervalMs?: number;
  signal?: AbortSignal;
};

/** 待っている途中でも中断できるようにした setTimeout */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** サイドカーの API を型付きで呼ぶ。トークンは全経路で必須 */
export class SidecarClient {
  constructor(private readonly connection: SidecarConnection) {}

  /** クエリ付きの URL を組み立てる。画像は img の src に直接使う */
  url(path: string, params: Record<string, string | number> = {}): string {
    const url = new URL(path, this.connection.baseUrl);
    url.searchParams.set("token", this.connection.token);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(
    path: string,
    params: Record<string, string | number> = {},
    init?: RequestInit,
  ): Promise<T> {
    const response = await fetch(this.url(path, params), init);
    if (!response.ok) {
      const detail = await response.text();
      throw new ApiError(response.status, detail || response.statusText);
    }
    return (await response.json()) as T;
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(
      path,
      {},
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/api/health");
  }

  listPages(archive: string): Promise<PagesResponse> {
    return this.request<PagesResponse>("/api/pages", { archive });
  }

  /** サムネイル候補 1 枚の寸法と見開き判定。name を省くと先頭ページ */
  cover(archive: string, name?: string): Promise<CoverResponse> {
    return this.request<CoverResponse>(
      "/api/cover",
      name ? { archive, name } : { archive },
    );
  }

  reorder(archive: string, order: string[]): Promise<JobAccepted> {
    return this.post<JobAccepted>("/api/jobs/reorder", { archive, order });
  }

  /**
   * ページ分割の画面に並べる行を走査する（#58 段階 3）。
   *
   * 数百枚の ZIP を 1 枚ずつ開くので、返るのはジョブの番号だけ。途中経過は
   * `waitForJob` で受け取る。
   */
  splitScan(archive: string): Promise<JobAccepted> {
    return this.post<JobAccepted>("/api/jobs/split-scan", { archive });
  }

  /** 割った結果を書き込む。行は差分ではなくページ順に全部を送る */
  applySplit(request: SplitConfirmRequest): Promise<JobAccepted> {
    return this.post<JobAccepted>("/api/jobs/split", request);
  }

  /** 本ごとに、サムネイル・並べ替え・分割結合のどれを施したか（#143） */
  async edits(paths: string[]): Promise<EditsResponse["edits"]> {
    return (await this.post<EditsResponse>("/api/edits", { paths })).edits;
  }

  /** ドロップされたファイルを実パスに結びつける */
  resolveDropped(
    files: { name: string; size: number }[],
  ): Promise<ResolveResult> {
    return this.post<ResolveResult>("/api/resolve", { files });
  }

  browse(path = ""): Promise<BrowseResult> {
    return this.request<BrowseResult>("/api/browse", { path });
  }

  knownEntries(query = ""): Promise<LibraryEntries> {
    return this.request<LibraryEntries>("/api/library/entries", { query });
  }

  saveEntry(title: string, author: string): Promise<unknown> {
    return this.post<unknown>("/api/library/entries", { title, author });
  }

  /**
   * 整理済みの蔵書から拾った対を、まとめて辞書へ入れる。
   *
   * 1 件ずつの `saveEntry` と違い、辞書に無い作品名だけが足される。既にある
   * 著者は上書きされない。辞書は以降のすべての整理で著者欄を埋める表なので、
   * 手で直した著者を潰さないよう、有無の確認と書き込みは辞書の全体が見える
   * サイドカー側で 1 つの操作として行わせる。
   */
  importEntries(entries: LibraryEntry[]): Promise<LibraryImportResult> {
    return this.post<LibraryImportResult>("/api/library/import", { entries });
  }

  deleteEntry(title: string): Promise<unknown> {
    return this.request<unknown>(
      "/api/library/entries",
      { title },
      { method: "DELETE" },
    );
  }

  cancelJob(id: string): Promise<unknown> {
    return this.post<unknown>(`/api/jobs/${id}/cancel`, {});
  }

  suggestAuthor(title: string): Promise<Suggestion> {
    return this.post<Suggestion>("/api/library/suggest", { title });
  }

  editCover(request: CoverRequest): Promise<JobAccepted> {
    return this.post<JobAccepted>("/api/jobs/cover", request);
  }

  /**
   * 出力先として選んだ場所を、サイドカーに覚えさせる。
   *
   * サイドカーは覚えのある場所へしか書き出さない。覚えはサイドカーが動いて
   * いる間だけ。利用者が出力先を決めた操作（DirectoryPicker）と、
   * 起動時に保存済みのデフォルト出力先を復元するときに呼ぶ。
   */
  chooseOutputRoot(directory: string): Promise<OutputRoot> {
    return this.post<OutputRoot>("/api/output-roots", { directory });
  }

  organize(request: OrganizeRequest): Promise<JobAccepted> {
    return this.post<JobAccepted>("/api/jobs/organize", request);
  }

  /** ファイルをごみ箱へ移す（#164）。消す前の確認は呼び出す側が済ませる */
  trashFile(path: string): Promise<Trashed> {
    return this.post<Trashed>("/api/files/trash", { path });
  }

  /** 出力先の作品フォルダに既にある本（#178）。番号を先着として数えるのに使う */
  async outputBooks(
    outputDirectory: string,
    title: string,
    author: string,
  ): Promise<OutputBook[]> {
    const found = await this.post<OutputBooks>("/api/output/books", {
      output_directory: outputDirectory,
      title,
      author,
    });
    return found.books;
  }

  /** 同じフォルダの中で名前をまとめて付け替える（#178）。番号の詰め直しに使う */
  renameFiles(renames: Rename[]): Promise<Renamed> {
    return this.post<Renamed>("/api/files/rename", { renames });
  }

  /**
   * 展開せずに、出来上がる本を実行前に調べる。
   *
   * 返るのはジョブの番号だけで、走査と目次読みはサイドカーが続ける。
   * 途中経過は `waitForJob` で受け取る。1 往復で返させると、数百 GB の
   * 蔵書では応答が数分返らないうえ、投入を編集するたびに止められない解析が
   * 積み上がる。
   *
   * 作品名と著者を渡すのは、サイドカーが組み立てた名前を突き合わせに使える
   * ようにするため。画面に出す名前は巻数から組み立て直すので、入力欄を
   * 変えるたびにここを呼び直すことはしない。
   */
  analyze(
    archives: string[],
    title: string,
    author: string,
  ): Promise<JobAccepted> {
    return this.post<JobAccepted>("/api/jobs/analyze", {
      archives,
      title,
      author,
    });
  }

  job(id: string, signal?: AbortSignal): Promise<JobResponse> {
    return this.request<JobResponse>(`/api/jobs/${id}`, {}, { signal });
  }

  /** 原寸画像の URL。img の src に直接使う */
  imageUrl(archive: string, name: string): string {
    return this.url("/api/image", { archive, name });
  }

  /**
   * そのページの加工前の画像の URL。
   *
   * 求めるのは加工後のページ名だけ。元画像が ZIP のどのエントリに入っているかは
   * サイドカーが決め、こちらへは出さない。
   */
  originalUrl(archive: string, name: string): string {
    return this.url("/api/original", { archive, name });
  }

  thumbnailUrl(archive: string, name: string, width: number): string {
    return this.url("/api/thumb", { archive, name, width });
  }

  /**
   * ジョブが終わるまで待つ。進捗は onProgress で受け取る。
   *
   * 呼び出し元の画面が消えても問い合わせが続くと、戻ってきたときに
   * 同じ対象へ二重にジョブを投入できてしまう。signal で確実に止められるようにする。
   */
  async waitForJob(
    id: string,
    onProgress?: (job: JobResponse) => void,
    { intervalMs = 200, signal }: WaitForJobOptions = {},
  ): Promise<JobResponse> {
    for (;;) {
      signal?.throwIfAborted();
      const job = await this.job(id, signal);
      onProgress?.(job);
      if (job.state !== "queued" && job.state !== "running") return job;
      await sleep(intervalMs, signal);
    }
  }
}
