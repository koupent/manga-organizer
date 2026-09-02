import { useEffect, useState } from "react";
import { SidecarClient } from "./api/client";
import { PageGrid } from "./components/PageGrid";
import { resolveConnection } from "./connection";

type Page = { name: string; size: number; modified: string };

/** ページ修正画面。整理画面は #25 の UI で追加する */
export function App() {
  const [client, setClient] = useState<SidecarClient | null>(null);
  const [archive, setArchive] = useState("");
  const [pages, setPages] = useState<Page[]>([]);
  const [cardWidth, setCardWidth] = useState(220);
  const [error, setError] = useState("");
  const [health, setHealth] = useState("");

  useEffect(() => {
    const connection = resolveConnection();
    if (!connection) {
      setError("サイドカーへの接続情報がありません");
      return;
    }
    const created = new SidecarClient(connection);
    setClient(created);

    const params = new URLSearchParams(window.location.search);
    setArchive(params.get("archive") ?? "");

    created
      .health()
      .then((payload) => setHealth(payload.status))
      .catch((reason) => setError(String(reason.message ?? reason)));
  }, []);

  useEffect(() => {
    if (!client || !archive) return;
    setError("");
    client
      .listPages(archive)
      .then((payload) => setPages(payload.pages as Page[]))
      .catch((reason) => setError(String(reason.message ?? reason)));
  }, [client, archive]);

  return (
    <main>
      <header>
        <h1>Manga Organizer</h1>
        <span data-testid="connection">{health}</span>
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
      </header>

      {error ? (
        <p data-testid="error">{error}</p>
      ) : null}

      {client && archive && pages.length > 0 ? (
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
