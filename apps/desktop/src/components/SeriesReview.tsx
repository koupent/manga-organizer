import { Play, Search, Wand2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Empty } from "./ui/empty";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
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
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

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
    setLog([]);
    setProgress({ current: 0, total: groups.length });
    const note = (line: string) => setLog((lines) => [...lines, line].slice(-200));
    try {
      const produced: string[] = [];
      for (const [index, group] of groups.entries()) {
        setProgress({ current: index, total: groups.length });
        note(`▶ ${group.title}`);
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
        for (const path of result?.produced ?? []) {
          note(`  ✓ ${path.split("/").pop()}`);
        }
        produced.push(...(result?.produced ?? []));
        // 次回の推定で使えるよう、確定した組み合わせを辞書へ残す
        if (group.author) {
          await client.saveEntry(group.title, group.author).catch(() => undefined);
        }
      }
      setProgress({ current: groups.length, total: groups.length });
      setStatus(`${produced.length} 冊を整理しました`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      note(`  ✗ ${message}`);
      setStatus(message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-semibold">推定結果</h2>
        <span className="tabular text-[12px] text-ink-faint" data-testid="group-count">
          {groups.length} 作品
        </span>
        <div className="flex-1" />
        <span className="text-[12px] text-ink-muted" data-testid="organize-status">
          {status}
        </span>
        <Button
          variant="primary"
          size="sm"
          data-testid="confirm"
          disabled={running || groups.length === 0}
          onClick={confirm}
        >
          <Play />
          この内容で整理する
        </Button>
      </div>

      {groups.length === 0 ? (
        <Empty icon={<Wand2 />} title="まだ推定していません">
          対象を選んで「作品を推定する」を押すと、作品ごとのまとまりが出ます。
          推定は外れることがあるので、ここで直してから確定してください。
        </Empty>
      ) : null}

      {progress.total > 0 ? (
        <Card>
          <CardBody className="flex flex-col gap-2">
            <div className="h-1 overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full bg-brand transition-[width] duration-200"
                data-testid="progress"
                style={{
                  width: `${(progress.current / Math.max(progress.total, 1)) * 100}%`,
                }}
              />
            </div>
            <pre
              className="max-h-40 overflow-y-auto rounded border border-line bg-canvas p-2 font-mono text-[11.5px] leading-relaxed text-ink-muted"
              data-testid="organize-log"
            >
              {log.join("\n")}
            </pre>
          </CardBody>
        </Card>
      ) : null}

      <div className="flex flex-col gap-2">
        {groups.map((group, index) => (
          <Card key={`${group.title}-${index}`} data-testid="series-group" data-title={group.title}>
            <CardHeader>
              <Input
                className="min-w-0 flex-[2_1_200px] font-medium"
                value={group.title}
                placeholder="作品名"
                data-testid="group-title"
                onChange={(event) => updateGroup(index, { title: event.target.value })}
              />
              <Input
                className="min-w-0 flex-1 basis-40"
                placeholder="著者"
                value={group.author ?? ""}
                data-testid="group-author"
                onChange={(event) => updateGroup(index, { author: event.target.value })}
              />
              <Button
                variant="ghost"
                size="sm"
                data-testid="suggest-author"
                onClick={() => suggestAuthor(index)}
              >
                <Search />
                著者を調べる
              </Button>
              <Badge
                tone={
                  confidenceLabel(group.confidence) === "高"
                    ? "ok"
                    : confidenceLabel(group.confidence) === "低"
                      ? "warn"
                      : "neutral"
                }
                data-testid="confidence"
              >
                推定 {confidenceLabel(group.confidence)}
              </Badge>
              {group.hasDuplicateVolumes ? (
                <Badge tone="warn" data-testid="duplicate-warning">
                  巻が重複しています
                </Badge>
              ) : null}
            </CardHeader>

            <ul className="divide-y divide-line/50">
              {group.volumes.map((volume) => (
                <li
                  key={volume.path}
                  data-testid="volume"
                  data-path={volume.path}
                  className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-surface-2"
                >
                  <span className="tabular w-8 rounded bg-surface-2 py-0.5 text-center text-[11.5px] text-ink-muted">
                    {volume.volume === null ? "—" : volume.volume}
                  </span>
                  <span className="flex-1 truncate text-[12.5px]">{volume.name}</span>
                  <Select
                    value=""
                    onValueChange={(value) => {
                      if (value) moveVolume(index, volume.path, value);
                    }}
                  >
                    <SelectTrigger data-testid="move-to" className="w-40">
                      <SelectValue placeholder="別の作品へ移す..." />
                    </SelectTrigger>
                    <SelectContent>
                      {groups
                        .filter((_, at) => at !== index)
                        .map((other) => (
                          <SelectItem key={other.title} value={other.title}>
                            {other.title}
                          </SelectItem>
                        ))}
                      <SelectItem value={`${volume.name} (単独)`}>
                        単独の作品にする
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </section>
  );
}
