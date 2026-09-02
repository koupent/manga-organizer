import { useEffect, useState } from "react";
import type { SidecarClient } from "../api/client";

type Entry = { name: string; path: string; is_directory: boolean };

type FilePickerProps = {
  client: SidecarClient;
  selected: string[];
  onChange: (paths: string[]) => void;
};

/**
 * 処理対象の選択。
 *
 * 元の Tkinter 版と同じく、まとめて放り込んで一覧で確認する形にする。
 * ブラウザはドロップされたファイルの実パスを取得できないため、
 * サーバー側を辿って選ぶ経路も用意する。Tauri ではネイティブのドロップが
 * 実パスを届けるので、そちらも同じ一覧へ入る。
 */
export function FilePicker({ client, selected, onChange }: FilePickerProps) {
  const [browsing, setBrowsing] = useState(false);
  const [location, setLocation] = useState<{ path: string; parent: string | null }>({
    path: "",
    parent: null,
  });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const load = (path = "") => {
    client
      .browse(path)
      .then((result) => {
        setLocation({ path: result.path, parent: result.parent ?? null });
        setEntries(result.entries as Entry[]);
        setError("");
      })
      .catch((reason) => setError(String(reason.message ?? reason)));
  };

  useEffect(() => {
    if (browsing && !location.path) load();
  }, [browsing]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (paths: string[]) => {
    onChange([...new Set([...selected, ...paths])]);
  };

  /**
   * ドロップから実パスを取り出す。
   *
   * VS Code のエクスプローラーや Linux のファイルマネージャは
   * text/uri-list に file:// の URI を載せてくる。取れる場合はそれが確実。
   */
  const pathsFromTransfer = (transfer: DataTransfer): string[] => {
    const raw =
      transfer.getData("text/uri-list") || transfer.getData("text/plain") || "";
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        if (!line.startsWith("file://")) return line.startsWith("/") ? line : "";
        try {
          return decodeURIComponent(new URL(line).pathname);
        } catch {
          return "";
        }
      })
      .filter(Boolean);
  };

  /**
   * ドロップを受ける。
   *
   * まず実パスが載っていればそれを使う。載っていない場合（多くのブラウザ）は
   * 名前とサイズを手がかりに、許可された場所の中から探して結びつける。
   * Tauri のネイティブなドロップは実パスが直接届くので、App が処理する。
   */
  const handleDrop = async (transfer: DataTransfer) => {
    const direct = pathsFromTransfer(transfer);
    if (direct.length > 0) {
      add(direct);
      setError("");
      return;
    }

    const dropped = Array.from(transfer.files).map((file) => ({
      name: file.name,
      size: file.size,
    }));
    if (dropped.length === 0) {
      setError(
        "ドロップされた内容からファイルを取り出せませんでした。" +
          "「ファイルを選ぶ」から辿ってください",
      );
      return;
    }
    setError("");
    try {
      const result = await client.resolveDropped(dropped);
      if (result.resolved.length > 0) add(result.resolved);
      const problems: string[] = [];
      if (result.unresolved.length > 0) {
        const roots = (result.searched_roots ?? []).join(" / ") || "(制限なし)";
        problems.push(
          `見つかりません: ${result.unresolved.join(", ")}` +
            `（探した場所: ${roots}。この中に無いファイルは扱えません）`,
        );
      }
      if (result.ambiguous.length > 0) {
        problems.push(
          `同名が複数あるため特定できません: ${result.ambiguous.join(", ")}`,
        );
      }
      setError(problems.join(" / "));
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    }
  };

  const addFolder = (folder: Entry) => {
    client
      .browse(folder.path)
      .then((result) =>
        add(
          (result.entries as Entry[])
            .filter((entry) => !entry.is_directory)
            .map((entry) => entry.path),
        ),
      )
      .catch((reason) => setError(String(reason.message ?? reason)));
  };

  return (
    <section className="picker">
      <div className="section-head">
        <h2 className="section-title">処理対象</h2>
        <span className="section-note" data-testid="selected-count">
          {selected.length} 件
        </span>
        <span className="header-spacer" />
        <button
          type="button"
          className="btn-secondary"
          data-testid="open-browser"
          onClick={() => setBrowsing((open) => !open)}
        >
          {browsing ? "選択を閉じる" : "ファイルを選ぶ"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          data-testid="clear-selection"
          disabled={selected.length === 0}
          onClick={() => onChange([])}
        >
          一覧を空にする
        </button>
      </div>

      <div
        className={`dropzone${dragging ? " over" : ""}`}
        data-testid="dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void handleDrop(event.dataTransfer);
        }}
      >
        {selected.length === 0 ? (
          <div className="empty">
            <strong>ここにアーカイブをドラッグ&ドロップ</strong>
            <p>
              または「ファイルを選ぶ」から辿ってください。zip / cbz / rar /
              7z を扱えます。
            </p>
          </div>
        ) : (
          <ul className="selected-list" data-testid="selected-list">
            {selected.map((path) => (
              <li key={path} data-testid="selected-item" data-path={path}>
                <span className="selected-name">{path.split("/").pop()}</span>
                <span className="selected-path">{path}</span>
                <button
                  type="button"
                  className="btn-ghost"
                  title="一覧から外す"
                  onClick={() => onChange(selected.filter((item) => item !== path))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? (
        <p className="banner" data-tone="error" data-testid="picker-error">
          {error}
        </p>
      ) : null}

      {browsing ? (
        <div className="panel browser" data-testid="file-browser">
          <div className="browser-bar">
            <button
              type="button"
              className="btn-ghost"
              data-testid="browse-up"
              disabled={!location.parent}
              onClick={() => location.parent && load(location.parent)}
            >
              ↑ 上へ
            </button>
            <code className="browser-path">{location.path}</code>
            <span className="header-spacer" />
            <button
              type="button"
              className="btn-secondary"
              data-testid="add-all-here"
              onClick={() =>
                add(
                  entries.filter((entry) => !entry.is_directory).map((e) => e.path),
                )
              }
            >
              ここのアーカイブを全部追加
            </button>
          </div>
          <ul className="browser-list">
            {entries.map((entry) => (
              <li key={entry.path} data-testid="browse-entry" data-name={entry.name}>
                <span className="browser-icon">{entry.is_directory ? "📁" : "📦"}</span>
                <button
                  type="button"
                  className="browser-name"
                  onClick={() =>
                    entry.is_directory ? load(entry.path) : add([entry.path])
                  }
                >
                  {entry.name}
                </button>
                {entry.is_directory ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => addFolder(entry)}
                  >
                    中身を追加
                  </button>
                ) : (
                  <span className="chip">
                    {selected.includes(entry.path) ? "追加済み" : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
