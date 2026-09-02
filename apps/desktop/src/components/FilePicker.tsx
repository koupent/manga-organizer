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
          // ブラウザでは実パスが取れない。Tauri のネイティブ側から届く
          // ドロップは App が受けてここへ渡す
          setError(
            "ブラウザではドロップされたファイルの場所を取得できません。" +
              "「ファイルを選ぶ」から辿ってください",
          );
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
          {error ? (
            <p className="banner" data-tone="error">
              {error}
            </p>
          ) : null}
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
