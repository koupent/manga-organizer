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
import { CoverCandidates } from "./CoverCandidates";
import {
  CropFrame,
  TARGET_RATIO,
  defaultCrop,
  toCropBox,
  type CropRect,
} from "./CropFrame";
import { Empty } from "./ui/empty";
import { SectionTitle } from "./ui/section-title";
import { fitInside, useBoxSize } from "../lib/stage";
import type { SidecarClient } from "../api/client";

/** 絵を囲う枠線の太さ。この画面で唯一、絵の縁を背景から切り分けるもの */
const FRAME_BORDER = 1;

/** viewer での見え方に使う幅。2:3 なので高さは 300px になる */
const PREVIEW_WIDTH = 200;

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

  // 絵を置ける面の実寸。候補一覧の開け閉てや窓の大きさで変わる
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();

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

  // 絵は枠線の内側に入る。枠線のぶんを先に引いてから収める大きさを決める
  const display = fitInside(cover, {
    width: stage.width - FRAME_BORDER * 2,
    height: stage.height - FRAME_BORDER * 2,
  });

  return (
    /*
      ワークベンチ型。判断の材料である絵に高さを全部渡し、操作は幅の決まった
      右の列へ寄せる。絵の上下に操作を積むと、積んだぶんだけ絵が縮む。
    */
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      {/* いま何を見ているか。1 行に収め、絵の取り分を削らない */}
      <div className="flex shrink-0 items-center gap-2">
        <h2
          className="min-w-0 truncate text-[13px] font-semibold"
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
        <span
          className="shrink-0 text-[12px] text-ink-faint"
          data-testid="cover-name"
        >
          {cover.name}
        </span>
        <Badge tone="neutral" data-testid="cover-size">
          <span className="tabular">
            {cover.width}×{cover.height}
          </span>
        </Badge>
        {/* 見開きの警告は、直す手立て（分割）の隣にある方が動きやすいので
            右の列に置く。ここには枠に収まっているかどうかだけを出す */}
        {cover.is_spread ? null : (
          <p
            className="shrink-0 text-[12px] text-ink-faint"
            data-testid="fits-frame"
          >
            {fitsFrame ? "枠に合っています" : "枠と縦横比が異なります"}
          </p>
        )}
        {/* 枠は掴めると分かって初めて使われる。説明は枠のある作業面の
            すぐ上に、常時出しておく */}
        <span className="shrink-0 text-[12px] text-ink-faint">
          枠を掴んで動かせます（2:3 固定）
        </span>
        <div className="flex-1" />
        <span
          className="shrink-0 text-[12px] text-ink-muted"
          data-testid="cover-status"
        >
          {status}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* 作業面。絵と、選んでいる間だけ出る候補一覧 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {/* 絵は上端を揃える。候補一覧の開け閉てで面の高さが変わっても、
              見ている絵が上下に泳がない */}
          <div
            ref={stageRef}
            className="flex min-h-0 flex-1 justify-center overflow-hidden"
          >
            {/* 枠の位置を画像そのものに合わせるため、枠線は外側の箱に持たせる */}
            <div
              className="relative self-start overflow-hidden rounded border border-line"
              style={{
                width: display.width + FRAME_BORDER * 2,
                height: display.height + FRAME_BORDER * 2,
              }}
            >
              <img
                data-testid="cover-image"
                className="block size-full"
                src={imageUrl}
                alt={cover.name}
              />
              <CropFrame image={cover} crop={frame} onChange={setCrop} />
            </div>
          </div>

          {choosing ? (
            <CoverCandidates
              client={client}
              archive={archive}
              pages={pages}
              current={cover.name}
              reloadKey={reloadKey}
              onSelect={(name) => {
                setSelected(name);
                setChoosing(false);
              }}
            />
          ) : null}
        </div>

        {/*
          操作の列。幅を 280px に固定するのは、ボタンも見え方の見本も
          広げて得をするものではないため。溢れたらこの列だけがスクロールし、
          絵は巻き添えにしない。
        */}
        <aside className="flex w-[280px] shrink-0 flex-col gap-2 overflow-y-auto">
          <section className="flex flex-col gap-1">
            <SectionTitle>viewer での見え方（2:3 中央クロップ）</SectionTitle>
            <div
              className="aspect-2/3 overflow-hidden rounded border border-line bg-canvas"
              style={{ width: PREVIEW_WIDTH }}
              data-testid="cover-frame"
            >
              <img
                className="size-full object-cover"
                src={imageUrl}
                alt="viewer での見え方"
              />
            </div>
          </section>

          {cover.is_spread ? (
            <Alert tone="warn" data-testid="spread-warning">
              <TriangleAlert />
              <span>
                見開きです。分割しないと viewer の表紙が正しく表示されません
              </span>
            </Alert>
          ) : null}

          <section className="flex flex-col gap-1.5">
            <SectionTitle>加工</SectionTitle>
            <Button
              variant="secondary"
              className="w-full"
              data-testid="choose-page"
              disabled={running}
              onClick={() => setChoosing((open) => !open)}
            >
              <Images />
              {choosing ? "候補を閉じる" : "画像を選ぶ"}
            </Button>
            {/* 2 つ 1 組の操作なので横に並べる。列の幅に収まる短い名前にし、
                言い足りないぶんは title で補う */}
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                variant="secondary"
                data-testid="crop-reset"
                title="切り抜く枠を初期状態に戻す"
                disabled={running}
                onClick={() => setCrop(null)}
              >
                <RotateCcw />
                枠を戻す
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
              <Button
                variant="secondary"
                data-testid="split-right"
                title="右半分を表紙にする"
                disabled={running}
                onClick={() => apply({ split: "right" })}
              >
                <SplitSquareHorizontal />
                右半分
              </Button>
              <Button
                variant="secondary"
                data-testid="split-left"
                title="左半分を表紙にする"
                disabled={running}
                onClick={() => apply({ split: "left" })}
              >
                <SplitSquareHorizontal />
                左半分
              </Button>
            </div>
          </section>

          {/* 主操作は列の最下部に固定する。操作の数で位置が上下すると、
              押す場所を毎回探すことになる */}
          <div className="mt-auto pt-2">
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              data-testid="apply-thumbnail"
              disabled={running}
              onClick={() => apply({ crop: frame, makeFirst: true })}
            >
              <Check />
              この範囲をサムネイルにする
            </Button>
          </div>
        </aside>
      </div>
    </section>
  );
}
