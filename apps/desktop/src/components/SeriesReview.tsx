import { useState } from "react";
import type { SidecarClient } from "../api/client";

export type SeriesVolume = { path: string; name: string; volume: number | null };
export type SeriesGroup = {
  title: string;
  author?: string;
  confidence: number;
  hasDuplicateVolumes: boolean;
  volumes: SeriesVolume[];
};

/** 確信度の低い推定を目立たせる */
function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "高";
  if (confidence >= 0.5) return "中";
  return "低";
}

type SeriesReviewProps = {
  client: SidecarClient;
  groups: SeriesGroup[];
  outputDirectory: string;
  onGroupsChange: (groups: SeriesGroup[]) => void;
};

/**
 * 推定したグルーピングを人が直してから確定する画面。
 *
 * 自動推定は必ず外れるので、直せることが本体。作品名の修正、別グループへの
 * 移動、グループの分割ができる。
 */
export function SeriesReview({
  client,
  groups,
  outputDirectory,
  onGroupsChange,
}: SeriesReviewProps) {
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);

  const updateGroup = (index: number, patch: Partial<SeriesGroup>) => {
    onGroupsChange(
      groups.map((group, at) => (at === index ? { ...group, ...patch } : group)),
    );
  };

  /** 外部サービスから著者名を補う。見つからなければ何もしない */
  const suggestAuthor = async (index: number) => {
    const group = groups[index];
    setStatus(`${group.title} の著者を調べています...`);
    try {
      const found = await client.suggestAuthor(group.title);
      if (found.author) {
        updateGroup(index, { author: found.author });
        setStatus(`著者を補完しました: ${found.author}`);
      } else {
        setStatus("著者が見つかりませんでした");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  /** 1 冊を別のグループへ移す。移動先が無ければ新しく作る */
  const moveVolume = (from: number, path: string, toTitle: string) => {
    const source = groups[from];
    const volume = source.volumes.find((item) => item.path === path);
    if (!volume) return;

    const remaining = {
      ...source,
      volumes: source.volumes.filter((item) => item.path !== path),
    };
    const next = groups.map((group, at) => (at === from ? remaining : group));
    const targetIndex = next.findIndex((group) => group.title === toTitle);
    if (targetIndex >= 0) {
      next[targetIndex] = {
        ...next[targetIndex],
        volumes: [...next[targetIndex].volumes, volume],
      };
    } else {
      next.push({
        title: toTitle,
        confidence: 1,
        hasDuplicateVolumes: false,
        volumes: [volume],
      });
    }
    onGroupsChange(next.filter((group) => group.volumes.length > 0));
  };

  const confirm = async () => {
    setRunning(true);
    setStatus("整理しています...");
    try {
      const produced: string[] = [];
      for (const group of groups) {
        const accepted = await client.organize({
          archives: group.volumes.map((volume) => volume.path),
          output_directory: outputDirectory,
          title: group.title,
          author: group.author ?? "",
          keep_originals: true,
        });
        const job = await client.waitForJob(accepted.id);
        if (job.state !== "succeeded") {
          throw new Error(job.error ?? `${group.title} の整理に失敗しました`);
        }
        const result = job.result as { produced?: string[] } | null;
        produced.push(...(result?.produced ?? []));
        // 次回の推定で使えるよう、確定した組み合わせを辞書へ残す
        if (group.author) {
          await client.saveEntry(group.title, group.author).catch(() => undefined);
        }
      }
      setStatus(`${produced.length} 冊を整理しました`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section>
      <div className="toolbar">
        <span data-testid="group-count">{groups.length} 作品</span>
        <button
          type="button"
          data-testid="confirm"
          disabled={running || groups.length === 0}
          onClick={confirm}
        >
          この内容で整理する
        </button>
        <span data-testid="organize-status">{status}</span>
      </div>

      <div className="groups">
        {groups.map((group, index) => (
          <article
            key={`${group.title}-${index}`}
            className="group"
            data-testid="series-group"
            data-title={group.title}
          >
            <header className="group-header">
              <input
                type="text"
                value={group.title}
                data-testid="group-title"
                onChange={(event) => updateGroup(index, { title: event.target.value })}
              />
              <input
                type="text"
                placeholder="著者"
                value={group.author ?? ""}
                data-testid="group-author"
                onChange={(event) => updateGroup(index, { author: event.target.value })}
              />
              <button
                type="button"
                data-testid="suggest-author"
                onClick={() => suggestAuthor(index)}
              >
                著者を調べる
              </button>
              <span
                className={`confidence c-${confidenceLabel(group.confidence)}`}
                data-testid="confidence"
              >
                推定 {confidenceLabel(group.confidence)}
              </span>
              {group.hasDuplicateVolumes ? (
                <span className="warning" data-testid="duplicate-warning">
                  巻が重複しています
                </span>
              ) : null}
            </header>

            <ul className="volumes">
              {group.volumes.map((volume) => (
                <li key={volume.path} data-testid="volume" data-path={volume.path}>
                  <span className="volume-number">
                    {volume.volume === null ? "-" : volume.volume}
                  </span>
                  <span className="volume-name">{volume.name}</span>
                  <select
                    data-testid="move-to"
                    value=""
                    onChange={(event) => {
                      if (event.target.value) {
                        moveVolume(index, volume.path, event.target.value);
                      }
                    }}
                  >
                    <option value="">別の作品へ移す...</option>
                    {groups
                      .filter((_, at) => at !== index)
                      .map((other) => (
                        <option key={other.title} value={other.title}>
                          {other.title}
                        </option>
                      ))}
                    <option value={`${volume.name} (単独)`}>単独の作品にする</option>
                  </select>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
