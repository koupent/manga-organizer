import type { ReactNode } from "react";
import { fitInside } from "../lib/stage";
import { cn } from "../lib/utils";

export type Picture = { imageUrl: string; width: number; height: number };

type PagePictureProps = {
  label: string;
  page: Picture;
  partner?: Picture;
  boxWidth: number;
  boxHeight: number;
  draft?: boolean;
  imageTestId: string;
  partnerTestId: string;
  children?: (size: {
    width: number;
    height: number;
    seam: number;
  }) => ReactNode;
};

/** 両モードで同じ寸法・左右順でページを描く。結合時は高い方に揃える */
export function PagePicture({
  label,
  page,
  partner,
  boxWidth,
  boxHeight,
  draft,
  imageTestId,
  partnerTestId,
  children,
}: PagePictureProps) {
  const height = partner ? Math.max(page.height, partner.height) : page.height;
  const ownWidth = (page.width * height) / page.height;
  const partnerWidth = partner ? (partner.width * height) / partner.height : 0;
  const display = fitInside(
    { width: ownWidth + partnerWidth, height },
    { width: boxWidth, height: boxHeight },
  );
  const scale = display.height / height;
  return (
    <div
      className={cn(
        "relative flex overflow-hidden",
        draft && "outline-2 outline-offset-2 outline-warn outline-dashed",
      )}
      style={{ width: display.width, height: display.height }}
    >
      {partner ? (
        <img
          data-testid={partnerTestId}
          className="block h-full object-contain"
          style={{ width: partnerWidth * scale }}
          src={partner.imageUrl}
          alt={`${label} ページの左に並ぶページ`}
          loading="lazy"
        />
      ) : null}
      <img
        data-testid={imageTestId}
        className="block h-full object-contain"
        style={{ width: ownWidth * scale }}
        src={page.imageUrl}
        alt={`${label} ページ`}
        loading="lazy"
      />
      {children?.({ ...display, seam: partnerWidth * scale })}
    </div>
  );
}
