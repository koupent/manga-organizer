import { PageCard } from "./PageCard";
import { PagePicture, type Picture } from "./PagePicture";
import { Checkbox } from "./ui/checkbox";
import type { MarginRequest } from "../api/client";

export function MarginFrame({
  margins,
}: {
  margins: MarginRequest["margins"];
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="margin-frame"
      className="pointer-events-none absolute border-2 border-brand bg-brand/5"
      style={{
        left: `${margins[0]}%`,
        top: `${margins[1]}%`,
        right: `${margins[2]}%`,
        bottom: `${margins[3]}%`,
      }}
    />
  );
}

/** 他の編集モードと同じ画像枠・フッターで、余白カットの選択だけを切り替える。 */
export function MarginCard({
  index,
  part,
  label,
  span,
  boxWidth,
  boxHeight,
  page,
  margins,
  checked,
  disabled,
  onToggle,
  onZoom,
}: {
  index: number;
  part?: 0 | 1;
  label: string;
  span: boolean;
  boxWidth: number;
  boxHeight: number;
  page: Picture;
  margins: MarginRequest["margins"];
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onZoom: () => void;
}) {
  return (
    <PageCard
      mode="margin"
      index={index}
      part={part}
      label={label}
      pending={false}
      focused={false}
      span={span}
      boxHeight={boxHeight}
      onZoom={onZoom}
      data-checked={checked}
      actions={
        <Checkbox
          disabled={disabled}
          checked={checked}
          aria-label={`${label} ページを切り取る`}
          onCheckedChange={onToggle}
        />
      }
    >
      <PagePicture
        label={label}
        page={page}
        boxWidth={boxWidth}
        boxHeight={boxHeight}
        imageTestId="margin-image"
        partnerTestId="margin-partner-image"
      >
        {() => <MarginFrame margins={margins} />}
      </PagePicture>
    </PageCard>
  );
}
