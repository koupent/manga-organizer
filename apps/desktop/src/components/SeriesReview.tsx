import { useState } from "react";
import type { SidecarClient } from "../api/client";

export type SeriesVolume = { path: string; name: string; volume: number | null };
export type SeriesGroup = {
  title: string;
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

  const renameGroup = (index: number, title: string) => {
    onGroupsChange(groups.map((group, at) => (at === index ? { ...group, title } : group)));
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
          author: "",
          keep_originals: true,
        });
        const job = await client.waitForJob(accepted.id);
        if (job.state !== "succeeded") {
          throw new Error(job.error ?? `${group.title} の整理に失敗しました`);
        }
        const result = job.result as { produced?: string[] } | null;
        produced.push(...(result?.produced ?? []));
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
                onChange={(event) => renameGroup(index, event.target.value)}
              />
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
