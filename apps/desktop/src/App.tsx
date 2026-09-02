import { useEffect, useState } from "react";
import { SidecarClient } from "./api/client";
import { CoverEditor } from "./components/CoverEditor";
import { PageGrid } from "./components/PageGrid";
import { FilePicker } from "./components/FilePicker";
import { SeriesReview, type SeriesGroup } from "./components/SeriesReview";
import { onFilesDropped, resolveConnection } from "./connection";

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
      <header className="app-header">
        <h1 className="brand">Manga Organizer</h1>
        <div className="segmented" role="group" aria-label="モード">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`mode-${item.id}`}
              aria-pressed={mode === item.id}
              onClick={() => setMode(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="header-spacer" />

        {mode === "pages" ? (
          <label className="slider-field">
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

        <span
          className="connection"
          data-testid="connection"
          data-state={health === "ok" ? "ok" : "off"}
          title={health === "ok" ? "サイドカーに接続済み" : "未接続"}
        >
          {health === "ok" ? "接続済み" : "未接続"}
        </span>
      </header>

      <div className="content">
        {error ? (
          <p className="banner" data-tone="error" data-testid="error">
            {error}
          </p>
        ) : null}

        {mode === "organize" && client ? (
          <>
            <FilePicker client={client} selected={sources} onChange={setSources} />

            <div className="panel">
              <div className="panel-body toolbar">
                <div className="field" style={{ flex: "1 1 320px" }}>
                  <span className="field-label">出力先</span>
                  <input
                    type="text"
                    data-testid="output-directory"
                    placeholder="/path/to/整理後"
                    value={outputDirectory}
                    onChange={(event) => setOutputDirectory(event.target.value)}
                  />
                </div>
                <span className="header-spacer" />
                <button
                  type="button"
                  className="btn-primary"
                  data-testid="estimate"
                  disabled={sources.length === 0}
                  onClick={estimate}
                >
                  作品を推定する
                </button>
              </div>
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
          <div className="empty">
            <strong>アーカイブが選ばれていません</strong>
            <p>
              URL に <code>archive=</code> を付けるか、整理モードでファイルを
              指定してください。
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
