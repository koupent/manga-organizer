import { AlignCenterVertical, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { SplitLine } from "./SplitLine";
import { PagePicture, type Picture } from "./PagePicture";
import { centerOf } from "../lib/split";
import { fitInside, useBoxSize } from "../lib/stage";
import { cn } from "../lib/utils";

/** 絵を囲う枠線の太さ。線と絵を同じ座標で重ねるため、先に引いておく */
const FRAME_BORDER = 1;

type SplitDialogProps = {
  /** 番号の札と同じ文字。"3" か "3–4" */
  label: string;
  /** この行が占めるページ番号。隅に出して、どちらが先かを示す */
  numbers: number[];
  checked: boolean;
  x: number;
  width: number;
  height: number;
  imageUrl: string;
  partner?: Picture;
  candidate: boolean;
  onToggle: () => void;
  onMoveSplit: (x: number) => void;
  onClose: () => void;
  /** 前後の見開きへ移る。-1 が前、+1 が次 */
  onWalk: (delta: number) => void;
};

/** 分割位置の読み取り。中央からどれだけ離れているかまで数で言う */
function readout(checked: boolean, x: number, width: number): string {
  if (!checked) return "分けません（1 ページのまま）";
  const offset = x - centerOf(width);
  const place =
    offset === 0 ? "中央" : `中央から ${offset > 0 ? "+" : ""}${offset} px`;
  return `分割位置 ${x} / ${width} px ・ ${place}`;
}

/**
 * 分割位置を大きく見て合わせるための重ね枠。
 *
 * **ここに確定は置かない。** 押す所が 2 つあると、どちらが書き込むのかが
 * 分からなくなる。主操作は画面に 1 つだけにして、ここは見て合わせるだけの
 * 場所にする。
 */
export function SplitDialog({
  label,
  numbers,
  checked,
  x,
  width,
  height,
  imageUrl,
  partner,
  candidate,
  onToggle,
  onMoveSplit,
  onClose,
  onWalk,
}: SplitDialogProps) {
  // 絵を置ける面の実寸。枠の高さを決め打ちしているので、開いた直後から測れる
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();
  const display = fitInside(
    { width, height },
    {
      width: stage.width - FRAME_BORDER * 2,
      height: stage.height - FRAME_BORDER * 2,
    },
  );

  const walk = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // 線に焦点があるときは線が先に受け取って止める。ここへ来るのは
    // 「線を掴んでいない」ときだけなので、前後の見開きへ移る
    event.preventDefault();
    onWalk(event.key === "ArrowRight" ? 1 : -1);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        data-testid="split-dialog"
        aria-describedby={undefined}
        /* 高さは上限ではなく実寸で決める。max-height だけだと中身の高さが
           決まらず、絵を置ける面が 0 になる */
        className="h-[85vh] w-[92vw]"
        onKeyDown={walk}
      >
        <div className="flex h-7 shrink-0 items-center gap-2">
          <DialogTitle className="tabular shrink-0 text-[13px] font-semibold">
            {label} ページ
          </DialogTitle>
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-muted">
            <Checkbox
              data-testid="split-dialog-check"
              aria-label={partner ? "結合を分ける" : "2 ページに分ける"}
              checked={checked}
              disabled={candidate}
              onCheckedChange={onToggle}
            />
            {partner ? "結合を分ける" : "2 ページに分ける"}
          </span>
          <div className="flex-1" />
          <Button
            variant="secondary"
            data-testid="split-center"
            disabled={!checked || Boolean(partner)}
            onClick={() => onMoveSplit(centerOf(width))}
          >
            <AlignCenterVertical />
            中央に戻す
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="split-dialog-close"
            aria-label="閉じる"
            title="閉じる"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>

        <div
          ref={stageRef}
          className="flex min-h-0 flex-1 items-start justify-center overflow-hidden"
        >
          {partner ? (
            <PagePicture
              label={label}
              page={{ imageUrl, width, height }}
              partner={partner}
              boxWidth={stage.width - FRAME_BORDER * 2}
              boxHeight={stage.height - FRAME_BORDER * 2}
              imageTestId="split-dialog-image"
              partnerTestId="split-dialog-partner-image"
            />
          ) : (
            <div
              className="relative overflow-hidden rounded border border-line"
              style={{
                width: display.width + FRAME_BORDER * 2,
                height: display.height + FRAME_BORDER * 2,
              }}
            >
              <img
                data-testid="split-dialog-image"
                className="block h-full w-full"
                src={imageUrl}
                alt={`${label} ページ`}
              />
              {checked ? (
                <SplitLine
                  label={label}
                  x={x}
                  width={width}
                  displayWidth={display.width}
                  overlay
                  onChange={onMoveSplit}
                />
              ) : null}
              {/* 右綴じなので、先に読むのは右半分。番号を隅に置いて、
                線をどちらへ寄せると何が起きるかを絵の上で示す */}
              <Corner side="right">{numbers[0]}</Corner>
              {numbers.length === 2 ? (
                <Corner side="left">{numbers[1]}</Corner>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex h-5 shrink-0 items-center gap-2">
          <span
            className="tabular text-[12px] text-ink-muted"
            data-testid="split-readout"
          >
            {partner
              ? candidate
                ? "結合候補です。結合する操作は「ページを結合」で行います"
                : "未保存の結合です。分けると結合を取り消します"
              : readout(checked, x, width)}
          </span>
          <div className="flex-1" />
          <span className="text-[11.5px] text-ink-faint">
            線を掴んで動かす ・ <Key>←</Key> <Key>→</Key> で前後の見開き ・{" "}
            <Key>Esc</Key> で閉じる
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 絵の隅に置く番号 */
function Corner({
  side,
  children,
}: {
  side: "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "tabular pointer-events-none absolute bottom-2 rounded border border-line",
        "bg-canvas/85 px-1.5 py-0.5 text-[12.5px] font-semibold text-ink",
        side === "right" ? "right-2" : "left-2",
      )}
    >
      {children}
    </span>
  );
}

/** ヒント内のキー表記 */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface-2 px-1 py-px font-sans text-[10.5px]">
      {children}
    </kbd>
  );
}
