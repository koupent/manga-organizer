import {
  Check,
  FolderOpen,
  Image as ImageIcon,
  Images,
  RotateCcw,
  RotateCw,
  SplitSquareHorizontal,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import {
  CropFrame,
  TARGET_RATIO,
  defaultCrop,
  toCropBox,
  type CropRect,
} from "./CropFrame";
import { Empty } from "./ui/empty";
import type { SidecarClient } from "../api/client";

/** 候補一覧に出す見本の幅。原寸を並べると読み込みが重い */
const CANDIDATE_WIDTH = 120;

type Cover = {
  name: string;
  width: number;
  height: number;
  is_spread: boolean;
  target_aspect_ratio: number;
};

/** 1 回の加工でサイドカーへ頼む内容。対象は画面が持っているので添えない */
type CoverEdit = {
  split?: "left" | "right";
  rotate?: number;
  crop?: CropRect;
  makeFirst?: boolean;
};

type CoverEditorProps = {
  client: SidecarClient;
  archive: string;
  archiveName?: string;
  onChangeArchive?: () => void;
};

/**
 * サムネイル作成の画面。
 *
 * viewer は辞書順で先頭のページを表紙として描き、縦長 2:3 に中央クロップする。
 * どの絵をサムネイルにするか選び、2:3 に切り抜いて先頭ページへ移す。
 * 見開きが先頭にある場合の分割・回転もここで行う。
 */
export function CoverEditor({
  client,
  archive,
  archiveName,
  onChangeArchive,
}: CoverEditorProps) {
  const [pages, setPages] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [cover, setCover] = useState<Cover | null>(null);
  // 枠を触っていない間は null。初期状態は画像の寸法から毎回導く
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  // 加工しても名前は変わらないことがある。ブラウザの画像キャッシュを外す鍵
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    client
      .listPages(archive)
      .then((payload) => {
        const names = payload.pages.map((page) => page.name);
        setPages(names);
        // 既定は先頭ページ。選び直した後は、その 1 枚が残っている限り保つ
        setSelected((current) =>
          names.includes(current) ? current : (names[0] ?? ""),
        );
      })
      .catch((reason) => setStatus(String(reason.message ?? reason)));
  }, [client, archive, reloadKey]);

  useEffect(() => {
    if (!selected) return;
    client
      .cover(archive, selected)
      .then((payload) => {
        setCover(payload as Cover);
        // 別の絵になれば枠の意味も変わる。持ち越さず初期状態から始める
        setCrop(null);
      })
      .catch((reason) => setStatus(String(reason.message ?? reason)));
  }, [client, archive, selected, reloadKey]);

  const apply = async (edit: CoverEdit) => {
    if (!cover) return;
    setRunning(true);
    setStatus("加工しています...");
    try {
      const accepted = await client.editCover({
        archive,
        name: cover.name,
        split: edit.split ?? null,
        crop: edit.crop ? toCropBox(edit.crop, cover) : null,
        rotate: edit.rotate ?? 0,
        make_first: edit.makeFirst ?? false,
      });
      const job = await client.waitForJob(accepted.id);
      if (job.state !== "succeeded") {
        throw new Error(job.error ?? "加工に失敗しました");
      }
      // 先頭へ移すと連番が振り直される。加工した 1 枚を新しい名前で追い続ける
      const produced = job.result as { name?: string } | null;
      if (produced?.name) setSelected(produced.name);
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
  const frame = crop ?? defaultCrop(cover);
  const imageUrl = `${client.imageUrl(archive, cover.name)}&v=${reloadKey}`;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2
          className="text-[13px] font-semibold"
          data-testid="thumbnail-archive-name"
        >
          {archiveName ?? "表紙"}
        </h2>
        {onChangeArchive ? (
          <Button
            variant="ghost"
            data-testid="change-archive"
            onClick={onChangeArchive}
          >
            <FolderOpen />
            別のファイルを選ぶ
          </Button>
        ) : null}
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
          <span>
            見開きです。分割しないと viewer の表紙が正しく表示されません
          </span>
        </Alert>
      ) : (
        <p className="text-[12px] text-ink-faint" data-testid="fits-frame">
          {fitsFrame ? "枠に合っています" : "枠と縦横比が異なります"}
        </p>
      )}

      <Card>
        <CardBody className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            data-testid="choose-page"
            disabled={running}
            onClick={() => setChoosing((open) => !open)}
          >
            <Images />
            {choosing ? "候補を閉じる" : "サムネイルにする画像を選ぶ"}
          </Button>
          <Button
            variant="secondary"
            data-testid="crop-reset"
            disabled={running}
            onClick={() => setCrop(null)}
          >
            <RotateCcw />
            枠を戻す
          </Button>
          <Button
            variant="secondary"
            data-testid="split-right"
            disabled={running}
            onClick={() => apply({ split: "right" })}
          >
            <SplitSquareHorizontal />
            右半分を表紙にする
          </Button>
          <Button
            variant="secondary"
            data-testid="split-left"
            disabled={running}
            onClick={() => apply({ split: "left" })}
          >
            左半分を表紙にする
          </Button>
          <Button
            variant="secondary"
            data-testid="rotate"
            disabled={running}
            onClick={() => apply({ rotate: 90 })}
          >
            <RotateCw />
            90 度回す
          </Button>
          <div className="flex-1" />
          <Button
            variant="primary"
            size="lg"
            data-testid="apply-thumbnail"
            disabled={running}
            onClick={() => apply({ crop: frame, makeFirst: true })}
          >
            <Check />
            この範囲をサムネイルにする
          </Button>
        </CardBody>
      </Card>

      {choosing ? (
        <Card data-testid="page-candidates">
          <CardHeader>
            <span className="text-[12px] text-ink-muted">
              サムネイルにする 1 枚を選ぶと、確定したときに先頭ページへ移ります
            </span>
          </CardHeader>
          <ul className="flex max-h-72 flex-wrap gap-2 overflow-y-auto p-2">
            {pages.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  data-testid="thumbnail-candidate"
                  data-name={name}
                  aria-pressed={name === cover.name}
                  className="flex w-28 flex-col items-center gap-1 rounded border border-line p-1 hover:border-brand"
                  onClick={() => {
                    setSelected(name);
                    setChoosing(false);
                  }}
                >
                  <img
                    className="max-h-28 rounded"
                    src={`${client.thumbnailUrl(archive, name, CANDIDATE_WIDTH)}&v=${reloadKey}`}
                    alt={name}
                  />
                  <span className="w-full truncate text-[11px] text-ink-muted">
                    {name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-start gap-6">
        <figure className="m-0 flex flex-col gap-1.5">
          <figcaption className="text-[12px] font-medium text-ink-muted">
            切り抜く範囲（枠は 2:3 固定。掴んで動かせます）
          </figcaption>
          {/* 枠の位置を画像そのものに合わせるため、枠線は外側の箱に持たせる */}
          <div className="relative self-start overflow-hidden rounded border border-line">
            <img
              data-testid="cover-image"
              className="block max-h-96"
              src={imageUrl}
              alt={cover.name}
            />
            <CropFrame image={cover} crop={frame} onChange={setCrop} />
          </div>
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
              src={imageUrl}
              alt="viewer での見え方"
            />
          </div>
        </figure>
      </div>
    </section>
  );
}
