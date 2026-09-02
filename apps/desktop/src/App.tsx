import { useEffect, useState } from "react";
import { SidecarClient } from "./api/client";
import { PageGrid } from "./components/PageGrid";
import { CoverEditor } from "./components/CoverEditor";
import { SeriesReview, type SeriesGroup } from "./components/SeriesReview";
import { onFilesDropped, resolveConnection } from "./connection";

type Page = { name: string; size: number; modified: string };
type Mode = "organize" | "pages" | "cover";

/** 整理とページ修正を切り替えて使う */
export function App() {
  const [client, setClient] = useState<SidecarClient | null>(null);
  const [mode, setMode] = useState<Mode>("pages");
  const [archive, setArchive] = useState("");
  const [pages, setPages] = useState<Page[]>([]);
  const [cardWidth, setCardWidth] = useState(220);
  const [error, setError] = useState("");
  const [health, setHealth] = useState("");

  // 整理モード
  const [sources, setSources] = useState("");
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
        setClient(new SidecarClient(connection));
        new SidecarClient(connection)
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
      setSources((current) =>
        [...new Set([...current.split("\n"), ...paths].filter(Boolean))].join("\n"),
      );
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
    const archives = sources
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      const payload = await client.estimateSeries(archives);
      setGroups(payload.groups as SeriesGroup[]);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  return (
    <main>
      <header>
        <h1>Manga Organizer</h1>
        <nav>
          <button
            type="button"
            data-testid="mode-organize"
            aria-pressed={mode === "organize"}
            onClick={() => setMode("organize")}
          >
            整理
          </button>
          <button
            type="button"
            data-testid="mode-cover"
            aria-pressed={mode === "cover"}
            onClick={() => setMode("cover")}
          >
            表紙
          </button>
          <button
            type="button"
            data-testid="mode-pages"
            aria-pressed={mode === "pages"}
            onClick={() => setMode("pages")}
          >
            ページ修正
          </button>
        </nav>
        <span data-testid="connection">{health}</span>
        {mode === "pages" ? (
          <label>
            表示サイズ
            <input
              type="range"
              min={140}
              max={520}
              step={20}
              value={cardWidth}
              data-testid="card-width"
              onChange={(event) => setCardWidth(Number(event.target.value))}
            />
          </label>
        ) : null}
      </header>

      {error ? <p data-testid="error">{error}</p> : null}

      {mode === "organize" && client ? (
        <>
          <div className="toolbar">
            <textarea
              data-testid="sources"
              rows={3}
              placeholder="整理するアーカイブのパスを 1 行に 1 つ"
              value={sources}
              onChange={(event) => setSources(event.target.value)}
            />
            <input
              type="text"
              data-testid="output-directory"
              placeholder="出力先"
              value={outputDirectory}
              onChange={(event) => setOutputDirectory(event.target.value)}
            />
            <button type="button" data-testid="estimate" onClick={estimate}>
              作品を推定する
            </button>
          </div>
          <SeriesReview
            client={client}
            groups={groups}
            outputDirectory={outputDirectory}
            onGroupsChange={setGroups}
          />
        </>
      ) : null}

      {mode === "cover" && client && archive ? (
        <CoverEditor client={client} archive={archive} />
      ) : null}

      {mode === "pages" && client && archive && pages.length > 0 ? (
        <PageGrid
          client={client}
          archive={archive}
          pages={pages}
          cardWidth={cardWidth}
        />
      ) : null}
    </main>
  );
}
