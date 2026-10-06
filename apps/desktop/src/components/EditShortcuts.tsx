import { Check, Pencil } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export type HandoffMode = "edit";
export type EditMarks = Readonly<Record<string, readonly string[]>>;
export const SHORTCUT_SIZE = "h-6 gap-1 px-1.5 text-[11.5px]";

export function EditShortcuts({
  name,
  path,
  edited,
  testIdPrefix,
  onOpen,
}: {
  name: string;
  path: string;
  edited: readonly string[];
  testIdPrefix: string;
  onOpen: (path: string, mode: HandoffMode) => void;
}) {
  const done = edited.length > 0;
  const label = `${name} を編集${done ? "（確認・編集済み）" : ""}`;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("relative", done ? "text-ok" : "text-ink-faint")}
      data-testid={`${testIdPrefix}-to-edit`}
      data-edited={done}
      title={label}
      aria-label={label}
      onClick={() => onOpen(path, "edit")}
    >
      <Pencil />
      {done ? (
        <Check
          aria-hidden
          strokeWidth={4}
          className="absolute -top-0.5 -right-0.5 size-2.5! rounded-full bg-ok p-px text-surface"
        />
      ) : null}
    </Button>
  );
}
