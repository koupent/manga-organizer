import {
  Check,
  FolderOpen,
  Image as ImageIcon,
  Images,
  RotateCcw,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CoverCandidates } from "./CoverCandidates";
import { CoverPreview } from "./CoverPreview";
import {
  CropFrame,
  TARGET_RATIO,
  defaultCrop,
  nextTurn,
  oppositeTurn,
  rotateCrop,
  rotatedSize,
  toCropBox,
  type CropRect,
  type QuarterTurn,
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
 *
 * 加工（切り抜きと回転）はすべて保留にし、確定したときに 1 回だけ書き込む。
 * 押すたびに書き込む作りでは、次の加工が書き換わった画像へ更に重なり、
 * 押した回数だけ原稿が縮み、JPEG が劣化する。取り返しが付かない。
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
  // 枠を触っていない間は null。初期状態は画像の寸法から毎回導く。
  // 座標は「回した後の絵」で持つ。画面で見えている向きと枠の向きが揃う
  const [crop, setCrop] = useState<CropRect | null>(null);
  // 保留中の回転。確定するまでファイルには触れない
  const [angle, setAngle] = useState<QuarterTurn>(0);
  const [choosing, setChoosing] = useState(false);
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  // 加工しても名前は変わらないことがある。ブラウザの画像キャッシュを外す鍵
  const [reloadKey, setReloadKey] = useState(0);

  // 絵を置ける面の実寸。候補一覧の開け閉てや窓の大きさで変わる
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();

  /** 保留中の加工をすべて捨てる */
  const resetEdits = () => {
    setCrop(null);
    setAngle(0);
  };

  /** 時計回りに 90 度回す。枠は回った絵に対して選び直す */
  const turnClockwise = () => {
    setAngle(nextTurn);
    // 絵の向きが変われば、どこを 2:3 で切るかも変わる。持ち越さない
    setCrop(null);
  };

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
        // 別の絵になれば加工の意味も変わる。持ち越さず初期状態から始める。
        // 確定した直後もここを通り、書き込み済みの加工が二重に残らない
        resetEdits();
      })
      .catch((reason) => setStatus(String(reason.message ?? reason)));
  }, [client, archive, selected, reloadKey]);

  /**
   * 溜めた加工をまとめて 1 回だけ書き込む。
   *
   * サイドカーは 切り抜き → 回転 の順に適用する。枠は回した後の座標で
   * 持っているので、逆向きに戻して元画像の座標へ直してから渡す。
   */
  const applyPending = async (frame: CropRect, turn: QuarterTurn) => {
    if (!cover) return;
    const shown = rotatedSize(cover, turn);
    const upright = rotateCrop(frame, shown, oppositeTurn(turn));
    setRunning(true);
    setStatus("加工しています...");
    try {
      const accepted = await client.editCover({
        archive,
        name: cover.name,
        split: null,
        crop: toCropBox(upright, cover),
        rotate: turn,
        make_first: true,
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
  // 保留の回転を織り込んだ、いま画面に見えている絵。枠もこの座標で持つ
  const shown = rotatedSize(cover, angle);
  const frame = crop ?? defaultCrop(shown);
  const imageUrl = `${client.imageUrl(archive, cover.name)}&v=${reloadKey}`;

  // 絵は枠線の内側に入る。枠線のぶんを先に引いてから収める大きさを決める
  const display = fitInside(shown, {
    width: stage.width - FRAME_BORDER * 2,
    height: stage.height - FRAME_BORDER * 2,
  });
  // 回す前の描画寸法。90 度と 270 度では縦横が入れ替わる
  const upright = rotatedSize(display, oppositeTurn(angle));

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
        {/* 保留の加工は、確定するまでファイルに残らない。回した角度は
            見えている絵からは読み取れないので、数値で添えておく */}
        {angle === 0 ? null : (
          <Badge tone="neutral" data-testid="pending-rotation">
            <span className="tabular">{angle} 度回転（未確定）</span>
          </Badge>
        )}
        {/* ここには枠に収まっているかどうかだけを出す。見開きの警告は
            右の列の先頭に置く */}
        {cover.is_spread ? null : (
          <p
            className="shrink-0 text-[12px] text-ink-faint"
            data-testid="fits-frame"
          >
            {fitsFrame ? "枠に合っています" : "枠と縦横比が異なります"}
          </p>
        )}
        {/* 枠は掴めると分かって初めて使われる。説明は枠のある作業面の
            すぐ上に出す。枠が退いている間は言っても指す先が無い */}
        {choosing ? null : (
          <span className="shrink-0 text-[12px] text-ink-faint">
            枠を掴んで動かせます（2:3 固定）
          </span>
        )}
        <div className="flex-1" />
        <span
          className="shrink-0 text-[12px] text-ink-muted"
          data-testid="cover-status"
        >
          {status}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* 作業面。切り抜きの面と候補一覧が、同じ場所を入れ替わりで使う。
            200 ページから 1 枚を探すには、帯ではなくこの面の広さが要る */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
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
          ) : (
            /* 絵は上端を揃える。窓の大きさで面の高さが変わっても、
               見ている絵が上下に泳がない */
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
                {/*
                  回転は保留なので、原稿ではなく見え方だけを回す。回す前の
                  寸法で置いてから中心で回すと、外側の箱にちょうど収まる。

                  max-width は外す。回す前の絵は箱より横に長く、既定の
                  「箱の幅まで」に刈られると、回した後に箱を埋められない。
                  絵と枠がずれ、枠で選んだ範囲と結果が食い違う。
                */}
                <img
                  data-testid="cover-image"
                  className="absolute block"
                  style={{
                    width: upright.width,
                    height: upright.height,
                    maxWidth: "none",
                    left: (display.width - upright.width) / 2,
                    top: (display.height - upright.height) / 2,
                    transform: `rotate(${angle}deg)`,
                  }}
                  src={imageUrl}
                  alt={cover.name}
                />
                <CropFrame image={shown} crop={frame} onChange={setCrop} />
              </div>
            </div>
          )}
        </div>

        {/*
          操作の列。幅を 280px に固定するのは、ボタンも見え方の見本も
          広げて得をするものではないため。溢れたらこの列だけがスクロールし、
          絵は巻き添えにしない。
        */}
        <aside className="flex w-[280px] shrink-0 flex-col gap-2 overflow-y-auto">
          {/* 警告は列の先頭に置く。見本と操作の間に出入りさせると、出た
              引っ込んだで押したいボタンが上下にずれ、連続して押せなくなる */}
          {cover.is_spread ? (
            <Alert tone="warn" data-testid="spread-warning">
              <TriangleAlert />
              <span>
                見開きです。使いたい側へ枠を寄せると、その半分が表紙になります
              </span>
            </Alert>
          ) : null}

          <section className="flex flex-col gap-1">
            <SectionTitle>viewer での見え方（2:3 中央クロップ）</SectionTitle>
            <div
              className="aspect-2/3 overflow-hidden rounded border border-line bg-canvas"
              style={{ width: PREVIEW_WIDTH }}
              data-testid="cover-frame"
            >
              {/* 保存済みの画像ではなく、保留中の加工を当てた結果を描く。
                  確定するまで結果が見えないと、確定してみるまで正しいか
                  分からない */}
              <CoverPreview
                src={imageUrl}
                image={cover}
                angle={angle}
                crop={frame}
                width={PREVIEW_WIDTH}
              />
            </div>
          </section>

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
                title="切り抜く枠と回転を初期状態に戻す"
                disabled={running}
                onClick={resetEdits}
              >
                <RotateCcw />
                加工を戻す
              </Button>
              <Button
                variant="secondary"
                data-testid="rotate"
                title="時計回りに 90 度回す（確定するまで書き込まない）"
                disabled={running}
                onClick={turnClockwise}
              >
                <RotateCw />
                90 度回す
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
              onClick={() => applyPending(frame, angle)}
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
