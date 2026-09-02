import { BookOpen, FileQuestion, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "./lib/utils";
import { SidecarClient } from "./api/client";
import { CoverEditor } from "./components/CoverEditor";
import { PageGrid } from "./components/PageGrid";
import { FilePicker } from "./components/FilePicker";
import { SeriesReview, type SeriesGroup } from "./components/SeriesReview";
import { onFilesDropped, resolveConnection } from "./connection";
import { Alert } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Card, CardBody } from "./components/ui/card";
import { Empty } from "./components/ui/empty";
import { Input } from "./components/ui/input";
import { Segmented } from "./components/ui/segmented";

type Page = { name: string; size: number; modified: string };
type Mode = "organize" | "pages" | "cover";

const MODES: { id: Mode; label: string }[] = [
  { id: "organize", label: "整理" },
  { id: "cover", label: "表紙" },
  { id: "pages", label: "ページ修正" },
];

/** 整理・表紙・ページ修正を切り替えて使う */
export function App() {
  const [client, setClient] = useState<SidecarClient | null>(null);
  const [mode, setMode] = useState<Mode>("pages");
  const [archive, setArchive] = useState("");
  const [pages, setPages] = useState<Page[]>([]);
  const [cardWidth, setCardWidth] = useState(220);
  const [error, setError] = useState("");
  const [health, setHealth] = useState("");

  const [sources, setSources] = useState<string[]>([]);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [groups, setGroups] = useState<SeriesGroup[]>([]);

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
    if (requested === "organize" || requested === "cover") setMode(requested);

    // ネイティブ側で受けたドロップを整理モードの入力に流し込む
    const pending = onFilesDropped((paths) => {
      setMode("organize");
      setSources((current) => [...new Set([...current, ...paths])]);
    });

    return () => {
      cancelled = true;
      pending.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!client || !archive || mode !== "pages") return;
    setError("");
    client
      .listPages(archive)
      .then((payload) => setPages(payload.pages as Page[]))
      .catch((reason) => setError(String(reason.message ?? reason)));
  }, [client, archive, mode]);

  const estimate = async () => {
    if (!client) return;
    setError("");
    try {
      const payload = await client.estimateSeries(sources);
      setGroups(payload.groups as SeriesGroup[]);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const archiveName = archive ? (archive.split("/").pop() ?? archive) : "";

  return (
    <main>
      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur">
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

        {mode === "pages" ? (
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

      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-3 p-4">
        {error ? (
          <Alert tone="danger" data-testid="error">
            <TriangleAlert />
            <span>{error}</span>
          </Alert>
        ) : null}

        {mode === "organize" && client ? (
          <>
            <FilePicker client={client} selected={sources} onChange={setSources} />

            <Card>
              <CardBody className="flex flex-wrap items-end gap-3">
                <label className="flex min-w-[320px] flex-1 flex-col gap-1">
                  <span className="text-[11.5px] font-medium text-ink-muted">
                    出力先
                  </span>
                  <Input
                    data-testid="output-directory"
                    placeholder="/path/to/整理後"
                    value={outputDirectory}
                    onChange={(event) => setOutputDirectory(event.target.value)}
                  />
                </label>
                <Button
                  variant="primary"
                  data-testid="estimate"
                  disabled={sources.length === 0}
                  onClick={estimate}
                >
                  <Sparkles />
                  作品を推定する
                </Button>
              </CardBody>
            </Card>

            <SeriesReview
              client={client}
              groups={groups}
              outputDirectory={outputDirectory}
              onGroupsChange={setGroups}
            />
          </>
        ) : null}

        {mode === "cover" && client && archive ? (
          <CoverEditor client={client} archive={archive} archiveName={archiveName} />
        ) : null}

        {mode === "pages" && client && archive && pages.length > 0 ? (
          <PageGrid
            client={client}
            archive={archive}
            archiveName={archiveName}
            pages={pages}
            cardWidth={cardWidth}
          />
        ) : null}

        {mode === "pages" && !archive ? (
          <Empty icon={<FileQuestion />} title="アーカイブが選ばれていません">
            URL に archive= を付けるか、整理モードでファイルを指定してください。
          </Empty>
        ) : null}
      </div>
    </main>
  );
}
