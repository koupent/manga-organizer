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
type EstimateResponse =
  paths["/api/series/estimate"]["post"]["responses"][200]["content"]["application/json"];
type JobResponse =
  paths["/api/jobs/{job_id}"]["get"]["responses"][200]["content"]["application/json"];
type HealthResponse =
  paths["/api/health"]["get"]["responses"][200]["content"]["application/json"];
type OrganizeRequest =
  paths["/api/jobs/organize"]["post"]["requestBody"]["content"]["application/json"];
type CoverRequest =
  paths["/api/jobs/cover"]["post"]["requestBody"]["content"]["application/json"];
type LibraryEntries =
  paths["/api/library/entries"]["get"]["responses"][200]["content"]["application/json"];
type Suggestion =
  paths["/api/library/suggest"]["post"]["responses"][200]["content"]["application/json"];
type BrowseResult =
  paths["/api/browse"]["get"]["responses"][200]["content"]["application/json"];
type ResolveResult =
  paths["/api/resolve"]["post"]["responses"][200]["content"]["application/json"];
type JobAccepted =
  paths["/api/jobs/reorder"]["post"]["responses"][202]["content"]["application/json"];

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

  cover(archive: string): Promise<CoverResponse> {
    return this.request<CoverResponse>("/api/cover", { archive });
  }

  estimateSeries(archives: string[]): Promise<EstimateResponse> {
    return this.post<EstimateResponse>("/api/series/estimate", { archives });
  }

  reorder(archive: string, order: string[]): Promise<JobAccepted> {
    return this.post<JobAccepted>("/api/jobs/reorder", { archive, order });
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

  organize(request: OrganizeRequest): Promise<JobAccepted> {
    return this.post<JobAccepted>("/api/jobs/organize", request);
  }

  job(id: string): Promise<JobResponse> {
    return this.request<JobResponse>(`/api/jobs/${id}`);
  }

  /** 原寸画像の URL。img の src に直接使う */
  imageUrl(archive: string, name: string): string {
    return this.url("/api/image", { archive, name });
  }

  thumbnailUrl(archive: string, name: string, width: number): string {
    return this.url("/api/thumb", { archive, name, width });
  }

  /** ジョブが終わるまで待つ。進捗は onProgress で受け取る */
  async waitForJob(
    id: string,
    onProgress?: (job: JobResponse) => void,
    intervalMs = 200,
  ): Promise<JobResponse> {
    for (;;) {
      const job = await this.job(id);
      onProgress?.(job);
      if (job.state !== "queued" && job.state !== "running") return job;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
