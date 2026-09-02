import { useEffect, useState } from "react";
import type { SidecarClient } from "../api/client";

/** viewer が表紙を描く枠の縦横比 */
const TARGET_RATIO = 2 / 3;

type Cover = {
  name: string;
  width: number;
  height: number;
  is_spread: boolean;
  target_aspect_ratio: number;
};

type CoverEditorProps = {
  client: SidecarClient;
  archive: string;
};

/**
 * 表紙の加工画面。
 *
 * viewer は表紙を縦長 2:3 に中央クロップして描くため、見開きが先頭にあると
 * 表紙が見えない。分割・回転で整える。
 */
export function CoverEditor({ client, archive }: CoverEditorProps) {
  const [cover, setCover] = useState<Cover | null>(null);
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // 対象が変わったときだけ表示を初期化する。加工後の再読み込みで
  // 「加工しました」を消さないよう、reloadKey とは分ける
  useEffect(() => {
    setStatus("");
    setCover(null);
  }, [archive]);

  useEffect(() => {
    if (!archive) return;
    client
      .cover(archive)
      .then((payload) => setCover(payload as Cover))
      .catch((reason) => setStatus(String(reason.message ?? reason)));
  }, [client, archive, reloadKey]);

  const apply = async (transform: {
    split?: "left" | "right";
    rotate?: number;
  }) => {
    if (!cover) return;
    setRunning(true);
    setStatus("加工しています...");
    try {
      const accepted = await client.editCover({
        archive,
        name: cover.name,
        split: transform.split ?? null,
        crop: null,
        rotate: transform.rotate ?? 0,
      });
      const job = await client.waitForJob(accepted.id);
      if (job.state !== "succeeded") {
        throw new Error(job.error ?? "加工に失敗しました");
      }
      setStatus("表紙を加工しました");
      setReloadKey((key) => key + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  if (!cover) {
    return (
      <section>
        <p data-testid="cover-status">{status || "読み込んでいます..."}</p>
      </section>
    );
  }

  const ratio = cover.width / cover.height;
  const fitsFrame = Math.abs(ratio - TARGET_RATIO) < 0.05;

  return (
    <section className="cover-editor">
      <div className="toolbar">
        <span data-testid="cover-name">{cover.name}</span>
        <span data-testid="cover-size">
          {cover.width}×{cover.height}
        </span>
        {cover.is_spread ? (
          <span className="warning" data-testid="spread-warning">
            見開きです。分割しないと表紙が正しく表示されません
          </span>
        ) : (
          <span data-testid="fits-frame">
            {fitsFrame ? "枠に合っています" : "枠と縦横比が異なります"}
          </span>
        )}
      </div>

      <div className="cover-actions">
        <button
          type="button"
          data-testid="split-right"
          disabled={running}
          onClick={() => apply({ split: "right" })}
        >
          右半分を表紙にする
        </button>
        <button
          type="button"
          data-testid="split-left"
          disabled={running}
          onClick={() => apply({ split: "left" })}
        >
          左半分を表紙にする
        </button>
        <button
          type="button"
          data-testid="rotate"
          disabled={running}
          onClick={() => apply({ rotate: 90 })}
        >
          90度回す
        </button>
        <span data-testid="cover-status">{status}</span>
      </div>

      <div className="cover-preview">
        <figure>
          <img
            data-testid="cover-image"
            src={`${client.imageUrl(archive, cover.name)}&v=${reloadKey}`}
            alt={cover.name}
          />
          <figcaption>実際の画像</figcaption>
        </figure>
        <figure>
          <div className="frame" data-testid="cover-frame">
            <img
              src={`${client.imageUrl(archive, cover.name)}&v=${reloadKey}`}
              alt="viewer での見え方"
            />
          </div>
          <figcaption>viewer での見え方（2:3 中央クロップ）</figcaption>
        </figure>
      </div>
    </section>
  );
}
