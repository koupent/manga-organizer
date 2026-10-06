import { Pencil } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Input } from "./ui/input";

export function FileNameEditor({
  name,
  onChange,
}: {
  name: string;
  onChange: (name: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const stem = draft.trim().replace(/\.zip$/i, "");
  const valid =
    Boolean(stem) &&
    !/[<>:"/\\|?*]/.test(stem) &&
    !Array.from(stem).some((char) => char.charCodeAt(0) < 32) &&
    !/[. ]$/.test(stem) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(stem);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="ml-1 size-5 shrink-0"
        data-testid="edit-filename"
        aria-label="出力ファイル名を編集"
        title="出力ファイル名を自由に変更"
        onClick={() => {
          setDraft(name.replace(/\.zip$/i, ""));
          setOpen(true);
        }}
      >
        <Pencil />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(36rem,92vw)] p-4">
          <DialogTitle>出力ファイル名を編集</DialogTitle>
          <DialogDescription>
            巻番号を含め、名前全体を変更できます。拡張子は .zip です。
          </DialogDescription>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) {
                onChange(stem + ".zip");
                setOpen(false);
              }
            }}
          >
            <div className="flex items-center gap-2">
              <Input
                data-testid="filename-input"
                aria-label="出力ファイル名"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <span>.zip</span>
            </div>
            {!valid ? (
              <p className="text-[12px] text-danger">
                フォルダを含まない、有効なファイル名を入力してください。
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                type="button"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                自動の名前に戻す
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!valid}
                data-testid="filename-confirm"
              >
                名前を変更
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
