import { Button } from "./ui/button";

/** 全モードで、対象選択と保存を同じ位置・表記に分ける。 */
export function EditorSelection({
  disabled,
  allDisabled,
  allTestId,
  onAll,
  onDetected,
  onClear,
}: {
  disabled: boolean;
  allDisabled: boolean;
  allTestId: string;
  onAll: () => void;
  onDetected: () => void;
  onClear: () => void;
}) {
  return (
    <span
      role="group"
      aria-label="処理対象の選択"
      className="flex shrink-0 items-center gap-1"
    >
      <Button
        variant="secondary"
        data-testid={allTestId}
        disabled={disabled || allDisabled}
        title="処理する対象を選択します。まだ保存しません"
        onClick={onAll}
      >
        全選択
      </Button>
      <Button
        variant="secondary"
        data-testid="editor-select-detected"
        disabled={disabled}
        title="自動検出された対象だけを選択します。まだ保存しません"
        onClick={onDetected}
      >
        自動検出分
      </Button>
      <Button
        variant="secondary"
        data-testid="editor-select-none"
        disabled={disabled}
        title="このモードの処理対象を解除します。保存済みの加工は戻しません"
        onClick={onClear}
      >
        全解除
      </Button>
    </span>
  );
}
