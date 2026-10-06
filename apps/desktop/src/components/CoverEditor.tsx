import {
  Check,
  Image as ImageIcon,
  RotateCcw,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CoverPreview } from "./CoverPreview";
import {
  CropFrame,
  TARGET_RATIO,
  defaultCrop,
  nextTurn,
  oppositeTurn,
  restoredEdit,
  rotateCrop,
  rotatedSize,
  toCropBox,
  type CropRect,
  type ImageSize,
  type Operation,
  type QuarterTurn,
} from "./CropFrame";
import { Empty } from "./ui/empty";
import { EditorLayout } from "./EditorLayout";
import { SectionTitle } from "./ui/section-title";
import { fitInside, useBoxSize } from "../lib/stage";
import { firstImageGeneration } from "../lib/utils";
import type { CoverRequest, SidecarClient } from "../api/client";

/** 絵を囲う枠線の太さ。この画面で唯一、絵の縁を背景から切り分けるもの */
const FRAME_BORDER = 1;

/** viewer での見え方に使う幅。2:3 なので高さは 300px になる */
const PREVIEW_WIDTH = 200;

/** 枠を置く相手の寸法 */
type CoverSource = ImageSize;

/** いま保存されている 1 枚の、加工前の姿 */
type CoverOriginal = CoverSource & {
  operations: Operation[];
};

type Cover = {
  name: string;
  width: number;
  height: number;
  is_spread: boolean;
  target_aspect_ratio: number;
  /** 加工前の画像。一度も加工していなければ null */
  original: CoverOriginal | null;
};

/**
 * 枠を置く相手の寸法。
 *
 * 加工前の画像が残っているならそちらを対象にする。保存済みの画像は既に
 * 切り抜かれていることがあり、それを対象にする限り枠は縮める方向にしか
 * 動かせない。利用者から見れば同じ 1 枚で、「元画像」と「加工後」の区別は
 * 画面に出さない。
 */
function sourceOf(cover: Cover): CoverSource {
  return cover.original ?? cover;
}

/**
 * 開いたときに置く枠と向き。
 *
 * 前回の加工が記録されていればその範囲を復元する。無ければ、触っていない
 * 状態（枠は画像の寸法から毎回導く）で始める。
 */
function initialEdit(cover: Cover): {
  crop: CropRect | null;
  angle: QuarterTurn;
} {
  const original = cover.original;
  const restored = original
    ? restoredEdit(original.operations, original)
    : null;
  return { crop: restored?.crop ?? null, angle: restored?.angle ?? 0 };
}

type CoverEditorProps = {
  client: SidecarClient;
  archive: string;
  pageName: string;
  onDraft: (request: CoverRequest) => void;
};

/**
 * サムネイルの画像調整。選んだ加工を共通編集画面へ返す。
 *
 * viewer は辞書順で先頭のページを表紙として描き、縦長 2:3 に中央クロップする。
 * どの絵をサムネイルにするか選んで切り取り、足りない側に余白を足して 2:3 に
 * してから先頭ページへ移す（#146）。2:3 の表紙なら viewer で切られない。
 *
 * 加工（切り抜きと回転）は保留にし、共通画面で保存したときに一度だけ書き込む。
 * 押すたびに書き込む作りでは、次の加工が書き換わった画像へ更に重なり、
 * 押した回数だけ原稿が縮み、JPEG が劣化する。取り返しが付かない。
 */
export function CoverEditor({
  client,
  archive,
  pageName,
  onDraft,
}: CoverEditorProps) {
  const selected = pageName;
  const [cover, setCover] = useState<Cover | null>(null);
  // 枠を触っていない間は null。初期状態は画像の寸法から毎回導く。
  // 座標は「回した後の絵」で持つ。画面で見えている向きと枠の向きが揃う
  const [crop, setCrop] = useState<CropRect | null>(null);
  // 保留中の回転。確定するまでファイルには触れない
  const [angle, setAngle] = useState<QuarterTurn>(0);
  const [status, setStatus] = useState("");
  // 加工しても名前は変わらないことがある。src が同じままだと img は取りに
  // 行かないので、確定のたびにここを進めて読み直させる。
  // これは「同じ画面で加工した」ときの合図でしかない。開き直したときに古い絵を
  // 出さないことは、サイドカー側の ETag による再確認が受け持つ
  const [reloadKey] = useState(firstImageGeneration);

  // 絵を置ける面の実寸。候補一覧の開け閉てや窓の大きさで変わる
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();

  /** 開いたときの状態から始める。前回の範囲があれば、そこへ枠を置き直す */
  const startFrom = (target: Cover) => {
    const start = initialEdit(target);
    setCrop(start.crop);
    setAngle(start.angle);
  };

  /** 保留中の加工をすべて捨て、開いたときの状態へ戻す */
  const resetEdits = () => {
    if (cover) startFrom(cover);
  };

  /** 時計回りに 90 度回す。枠は回った絵に対して選び直す */
  const turnClockwise = () => {
    setAngle(nextTurn);
    // 絵の向きが変われば、どこを 2:3 で切るかも変わる。持ち越さない
    setCrop(null);
  };

  useEffect(() => {
    if (!selected) return;
    // 選び直すと問い合わせが重なり、返る順は保証されない。遅れて届いた
    // 古い応答を採ると、画面は選び直す前の 1 枚に戻る。そのまま確定すれば
    // 利用者が選んでいない 1 枚が切り抜かれ、元の絵は失われる
    let alive = true;
    client
      .cover(archive, selected)
      .then((payload) => {
        if (!alive) return;
        const next = payload as Cover;
        setCover(next);
        // 別の絵になれば加工の意味も変わる。持ち越さず、その 1 枚の初期状態から
        // 始める。確定した直後もここを通り、書き込み済みの加工が二重に残らない
        startFrom(next);
      })
      .catch((reason) => {
        if (alive) setStatus(String(reason.message ?? reason));
      });
    return () => {
      alive = false;
    };
  }, [client, archive, selected, reloadKey]);

  /**
   * 溜めた加工をまとめて 1 回だけ書き込む。
   *
   * サイドカーは 切り抜き → 回転 の順に適用する。枠は回した後の座標で
   * 持っているので、逆向きに戻して元画像の座標へ直してから渡す。
   */
  const applyPending = (frame: CropRect, turn: QuarterTurn) => {
    if (!cover) return;
    const source = sourceOf(cover);
    const shown = rotatedSize(source, turn);
    const upright = rotateCrop(frame, shown, oppositeTurn(turn));
    onDraft({
      archive,
      name: cover.name,
      split: null,
      crop: toCropBox(upright, source),
      rotate: turn,
      make_first: true,
      from_original: Boolean(cover.original),
    });
  };

  if (!cover) {
    return (
      <Empty icon={<ImageIcon />} title={status || "読み込んでいます..."}>
        <span data-testid="cover-status">{status}</span>
      </Empty>
    );
  }

  // 寸法の表示と見開きの判定は、いま保存されている 1 枚を指す。
  // 枠を置く相手（加工前の画像）とは別物なので混ぜない
  const ratio = cover.width / cover.height;
  const fitsFrame = Math.abs(ratio - TARGET_RATIO) < 0.05;
  const source = sourceOf(cover);
  // 保留の回転を織り込んだ、いま画面に見えている絵。枠もこの座標で持つ
  const shown = rotatedSize(source, angle);
  const frame = crop ?? defaultCrop(shown);
  // v は「同じ名前のまま中身が変わった」ときに img へ取り直させるための鍵。
  // 中身が変わったかどうかの判定そのものはサイドカーの ETag が担う
  const imageUrl = `${
    cover.original
      ? client.originalUrl(archive, cover.name)
      : client.imageUrl(archive, cover.name)
  }&v=${reloadKey}`;

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
    <EditorLayout
      toolbar={
        <>
          {/* この行に並ぶ名前・寸法・枠の判定は、いま保存されている 1 枚の値。
            見えている絵と枠は加工前の画像なので、見出しを付けないと
            1600×1200 の見開きを見ながら「800×1200」「枠に合っています」と
            書かれた画面になり、矛盾しているようにしか読めない */}
          <span className="shrink-0 text-[12px] text-ink-faint">
            保存されている表紙
          </span>
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
          <span className="shrink-0 text-[12px] text-ink-faint">
            枠を掴んで動かし、右下の角で大きさを変えます（足りない所は縁の色で塗って
            2:3 にします）
          </span>
          <div className="flex-1" />
          <span
            className="min-w-0 truncate text-[12px] text-ink-muted"
            data-testid="cover-status"
            title={status}
          >
            {status}
          </span>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 gap-3">
        {/* 作業面。切り抜きの面と候補一覧が、同じ場所を入れ替わりで使う。
            200 ページから 1 枚を探すには、帯ではなくこの面の広さが要る */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div
            ref={stageRef}
            className="flex min-h-0 flex-1 justify-center overflow-hidden"
          >
            {/* 枠の位置を絵そのものに合わせるため、枠線は外側の箱に持たせる */}
            <div
              data-testid="cover-canvas"
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
              {/* 判定の相手は保存されている 1 枚。見えている絵が見開きでも、
                  保存済みが片側だけならこの警告は出ない。どちらの話かを
                  文面で言っておかないと、出ない理由が分からない */}
              <span>
                保存されている表紙は見開きです。使いたい側へ枠を寄せると、その半分が表紙になります
              </span>
            </Alert>
          ) : null}

          <section className="flex flex-col gap-1">
            <SectionTitle>viewer での見え方（2:3）</SectionTitle>
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
                image={source}
                angle={angle}
                crop={frame}
                width={PREVIEW_WIDTH}
              />
            </div>
          </section>

          <section className="flex flex-col gap-1.5">
            <SectionTitle>加工</SectionTitle>
            {/* 2 つ 1 組の操作なので横に並べる。列の幅に収まる短い名前にし、
                言い足りないぶんは title で補う */}
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                variant="secondary"
                data-testid="crop-reset"
                title="切り抜く枠と回転を初期状態に戻す"
                onClick={resetEdits}
              >
                <RotateCcw />
                加工を戻す
              </Button>
              <Button
                variant="secondary"
                data-testid="rotate"
                title="時計回りに 90 度回す（確定するまで書き込まない）"
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
              onClick={() => applyPending(frame, angle)}
            >
              <Check />
              この調整を使う
            </Button>
          </div>
        </aside>
      </div>
    </EditorLayout>
  );
}
