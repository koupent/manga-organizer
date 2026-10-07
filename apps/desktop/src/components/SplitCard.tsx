import { cn } from "../lib/utils";
import { PageCard } from "./PageCard";
import { PagePicture, type Picture } from "./PagePicture";
import { Badge } from "./ui/badge";
import { Checkbox } from "./ui/checkbox";
import { SplitLine } from "./SplitLine";

type SplitCardProps = {
  /** ページ順での位置。0 から数える */
  index: number;
  part?: 0 | 1;
  /** 番号の札に出す文字。"3" か "3–4" */
  label: string;
  actionLabel: string;
  /** 書き込む前と違うか */
  pending: boolean;
  /** いま ZIP の中で 2 ページに割れているか */
  applied: boolean;
  /** 前後の送りボタンで、いま指している行か（#131） */
  focused: boolean;
  checked: boolean;
  /** 選んだ種類の分割対象か */
  target: boolean;
  /** 結合・復元して 1 枚にした画像か */
  keptWhole: boolean;
  /** 2 列ぶんを占める横長か */
  wide: boolean;
  /** 実際に 2 列を跨がせるか。1 列しか無い窓では跨がせられない */
  span: boolean;
  /** 絵の箱。行をまたいで同じ高さにする */
  boxWidth: number;
  boxHeight: number;
  x: number;
  page: Picture;
  partner?: Picture;
  /** 未保存の結合を分ける操作か */
  joined: boolean;
  candidate: boolean;
  onToggle: () => void;
  onMoveSplit: (x: number) => void;
  onZoom: () => void;
};

/**
 * 「ページを分割」の 1 行ぶんのカード。
 *
 * **ファイル名は受け取らないし、出さない。** 割った対は 2 つの名前を持ち、
 * まだ割っていない見開きは 1 つしか持たない。どちらを出しても「元画像」と
 * 「割った半分」の区別が画面に現れ、利用者が知らずに済むはずのものを
 * 知らせてしまう。渡すのは絵の URL と、数え直した番号だけ。
 *
 * まだ選んでいない対象は、分ける位置を点線で示す。押す前に、そこで分けて
 * よいかを目で確かめられる。
 */
export function SplitCard({
  index,
  part,
  label,
  actionLabel,
  pending,
  applied,
  focused,
  checked,
  target,
  keptWhole,
  wide,
  span,
  boxWidth,
  boxHeight,
  x,
  page,
  partner,
  joined,
  candidate,
  onToggle,
  onMoveSplit,
  onZoom,
}: SplitCardProps) {
  const draft = target && !checked && !joined;

  const splitLabel = joined
    ? `${label} ページの未保存の結合を分ける`
    : part !== undefined
      ? `${actionLabel} ページの分割を残す`
      : `${label} ページを 2 ページに分ける`;
  return (
    <PageCard
      mode="split"
      index={index}
      part={part}
      label={label}
      pending={pending}
      focused={focused}
      span={span}
      boxHeight={boxHeight}
      onZoom={onZoom}
      data-checked={checked}
      data-wide={wide}
      data-target={target}
      actions={
        <Checkbox
          data-testid="split-check"
          title={splitLabel}
          aria-label={splitLabel}
          checked={checked}
          disabled={candidate}
          onCheckedChange={onToggle}
          className={cn(
            "shrink-0",
            // 横長でないページを分けることは少ない。指したカードにだけ出す
            !checked &&
              !applied &&
              !wide &&
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        />
      }
      status={
        <>
          {applied ? (
            <Badge tone="ok" data-testid="split-applied">
              分割済み
            </Badge>
          ) : null}
          {joined ? <Badge>結合する</Badge> : null}
          {candidate ? <Badge tone="warn">結合候補</Badge> : null}
          {keptWhole && !checked ? (
            <Badge
              data-testid="split-kept-whole"
              title="結合・復元した画像です。分割対象で選ぶと一括分割できます"
            >
              結合・復元済み
            </Badge>
          ) : null}
        </>
      }
    >
      <PagePicture
        label={label}
        page={page}
        partner={partner}
        boxWidth={boxWidth}
        boxHeight={boxHeight}
        draft={draft}
        imageTestId="split-image"
        partnerTestId="split-partner-image"
      >
        {(display) =>
          checked && part === undefined && !joined ? (
            <SplitLine
              label={label}
              x={x}
              width={page.width}
              displayWidth={display.width}
              onChange={onMoveSplit}
            />
          ) : draft && part === undefined ? (
            <div
              data-testid="split-draft-line"
              aria-hidden
              className="pointer-events-none absolute inset-y-0 border-l-2 border-dashed border-warn"
              style={{ left: (x / page.width) * display.width - 1 }}
            />
          ) : null
        }
      </PagePicture>
    </PageCard>
  );
}
