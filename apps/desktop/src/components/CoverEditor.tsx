import {
  Image as ImageIcon,
  RotateCw,
  SplitSquareHorizontal,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardBody } from "./ui/card";
import { Empty } from "./ui/empty";
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
  archiveName?: string;
};

/**
 * 表紙の加工画面。
 *
 * viewer は表紙を縦長 2:3 に中央クロップして描くため、見開きが先頭にあると
 * 表紙が見えない。分割・回転で整える。
 */
export function CoverEditor({ client, archive, archiveName }: CoverEditorProps) {
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
      <Empty icon={<ImageIcon />} title={status || "読み込んでいます..."}>
        <span data-testid="cover-status">{status}</span>
      </Empty>
    );
  }

  const ratio = cover.width / cover.height;
  const fitsFrame = Math.abs(ratio - TARGET_RATIO) < 0.05;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold">{archiveName ?? "表紙"}</h2>
        <span className="text-[12px] text-ink-faint" data-testid="cover-name">
          {cover.name}
        </span>
        <Badge tone="neutral" data-testid="cover-size">
          <span className="tabular">
            {cover.width}×{cover.height}
          </span>
        </Badge>
        <div className="flex-1" />
        <span className="text-[12px] text-ink-muted" data-testid="cover-status">
          {status}
        </span>
      </div>

      {cover.is_spread ? (
        <Alert tone="warn" data-testid="spread-warning">
          <TriangleAlert />
          <span>見開きです。分割しないと viewer の表紙が正しく表示されません</span>
        </Alert>
      ) : (
        <p className="text-[12px] text-ink-faint" data-testid="fits-frame">
          {fitsFrame ? "枠に合っています" : "枠と縦横比が異なります"}
        </p>
      )}

      <Card>
        <CardBody className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            data-testid="split-right"
            disabled={running}
            onClick={() => apply({ split: "right" })}
          >
            <SplitSquareHorizontal />
            右半分を表紙にする
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="split-left"
            disabled={running}
            onClick={() => apply({ split: "left" })}
          >
            左半分を表紙にする
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="rotate"
            disabled={running}
            onClick={() => apply({ rotate: 90 })}
          >
            <RotateCw />
            90 度回す
          </Button>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-start gap-6">
        <figure className="m-0 flex flex-col gap-1.5">
          <figcaption className="text-[12px] font-medium text-ink-muted">
            実際の画像
          </figcaption>
          <img
            data-testid="cover-image"
            className="max-h-96 rounded border border-line"
            src={`${client.imageUrl(archive, cover.name)}&v=${reloadKey}`}
            alt={cover.name}
          />
        </figure>
        <figure className="m-0 flex flex-col gap-1.5">
          <figcaption className="text-[12px] font-medium text-ink-muted">
            viewer での見え方（2:3 中央クロップ）
          </figcaption>
          <div
            className="aspect-2/3 w-56 overflow-hidden rounded border border-line bg-canvas"
            data-testid="cover-frame"
          >
            <img
              className="size-full object-cover"
              src={`${client.imageUrl(archive, cover.name)}&v=${reloadKey}`}
              alt="viewer での見え方"
            />
          </div>
        </figure>
      </div>
    </section>
  );
}
