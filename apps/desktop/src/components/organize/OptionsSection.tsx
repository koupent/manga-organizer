import type { SidecarClient } from "../../api/client";
import { DirectoryPicker } from "../DirectoryPicker";
import { Checkbox } from "../ui/checkbox";
import { SectionTitle } from "../ui/section-title";

type OptionsSectionProps = {
  client: SidecarClient;
  outputDirectory: string;
  onOutputDirectoryChange: (path: string) => void;
  onOpenSettings: () => void;
  keepOriginals: boolean;
  onKeepOriginalsChange: (keep: boolean) => void;
};

/** 整理のオプションの区画。出力先と、元のファイルを残すかどうか */
export function OptionsSection({
  client,
  outputDirectory,
  onOutputDirectoryChange,
  onOpenSettings,
  keepOriginals,
  onKeepOriginalsChange,
}: OptionsSectionProps) {
  return (
    <section
      className="flex shrink-0 flex-col gap-2"
      data-testid="organize-options"
    >
      <SectionTitle>オプション</SectionTitle>
      <DirectoryPicker
        client={client}
        value={outputDirectory}
        onChange={onOutputDirectoryChange}
        onOpenSettings={onOpenSettings}
      />
      <label className="flex w-fit cursor-pointer items-center gap-2 text-[12.5px] text-ink-muted">
        <Checkbox
          data-testid="keep-originals"
          checked={keepOriginals}
          onCheckedChange={(checked) => onKeepOriginalsChange(checked === true)}
        />
        元のファイルを残す
      </label>
    </section>
  );
}
